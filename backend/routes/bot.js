const express = require('express');
const router = express.Router();
const axios = require('axios');
const fs = require('fs');
const fsExtra = require('fs-extra');
const path = require('path');
const FormData = require('form-data');
const telegramService = require('../services/telegram');
const sandboxManager = require('../sandbox/manager');
const sessionStore = require('../services/sessionStore');
const userStore = require('../services/userStore');
const Redis = require('ioredis');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOT_SECRET = process.env.BOT_WEBHOOK_SECRET || '';
const BOT_SESSION_ID = process.env.BOT_SESSION_ID || '';
// Eager start: don't block on meta/limits at webhook stage
const BOT_EAGER_START = process.env.BOT_EAGER_START === '1';
// Fast path: skip Redis queue and start immediately when possible
const BOT_FAST_START = process.env.BOT_FAST_START === '1';
// Link for "👉点此查看如何复制消息链接"
const START_HELP_URL = process.env.BOT_START_HELP_URL || 'https://t.me/takemsgg';
const BOT_KEEP_FILE_MINUTES = parseInt(process.env.BOT_KEEP_FILE_MINUTES || '30', 10); // For URL fallback cleanup
const BOT_WEB_LOGIN_URL = process.env.BOT_WEB_LOGIN_URL || process.env.PUBLIC_BASE_URL || '';
const BOT_BIND_SECRET = process.env.BOT_BIND_SECRET || '';
// ---- Redis queue & lock ----
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const redis = new Redis(REDIS_URL);
const QUEUE_KEY = process.env.REDIS_QUEUE_KEY || 'td:queue';
const LOCK_PREFIX = process.env.REDIS_LOCK_PREFIX || 'td:lock:chat:';
const LOCK_TTL_SEC = parseInt(process.env.REDIS_LOCK_TTL_SEC || '1800', 10);
const WATCHDOG_IDLE_MS = parseInt(process.env.WATCHDOG_IDLE_MS || '30000', 10);
const DOWNLOAD_MAX_RETRY = parseInt(process.env.DOWNLOAD_MAX_RETRY || '2', 10);
const QUEUE_CONCURRENCY = parseInt(process.env.QUEUE_CONCURRENCY || process.env.SANDBOX_MAX_ACTIVE || '2', 10);

function assertBotConfigured(res) {
  if (!BOT_TOKEN) {
    res.status(500).json({ error: 'BOT_TOKEN not configured' });
    return false;
  }
  return true;
}
// Per-chat session binding (persistent)
const CHAT_SESSIONS_PATH = path.join(process.cwd(), 'sessions', 'chatSessions.json');
let chatSessions = {};
try { chatSessions = JSON.parse(fs.readFileSync(CHAT_SESSIONS_PATH, 'utf8')); } catch (_) { chatSessions = {}; }
async function saveChatSessions() {
  try {
    await fsExtra.ensureDir(path.dirname(CHAT_SESSIONS_PATH));
    await fsExtra.writeJson(CHAT_SESSIONS_PATH, chatSessions, { spaces: 2 });
  } catch (_) {}
}

async function getWorkingSessionId(chatId) {
  if (chatId && chatSessions[String(chatId)]) return chatSessions[String(chatId)];
  if (BOT_SESSION_ID) return BOT_SESSION_ID;
  // 为避免多个聊天误用同一个已登录会话，这里不再使用“第一个已认证会话”的回退。
  // 未绑定且未配置 BOT_SESSION_ID 时，要求用户先 /login 绑定。
  return null;
}

// ----- Reply keyboard -----
const BTN_INVITE = '✉️ 邀请好友';
const BTN_TOPUP = '💰 充值';
const BTN_ME = '👤 我的';
const CMD_LOGIN = '/login';
const CMD_LOGOUT = '/logout';

function defaultReplyKeyboard() {
  return {
    keyboard: [
      [{ text: BTN_INVITE }, { text: BTN_TOPUP }],
      [{ text: BTN_ME }]
    ],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
    input_field_placeholder: '输入链接或选择功能…'
  };
}

function startInlineKeyboard() {
  // Three inline buttons as shown: 邀请好友 / 充值 / 我的
  return {
    inline_keyboard: [
      [
        { text: BTN_INVITE, callback_data: 'invite' },
        { text: BTN_TOPUP, callback_data: 'topup' },
      ],
      [
        { text: BTN_ME, callback_data: 'me' },
      ],
    ],
  };
}

function getStartMessageText() {
  return (
    '<b>欢迎使用电报消息提取器！</b>\n' +
    '只需发送一条包含媒体的消息链接，即可一键提取内容！\n\n' +
    '支持提取 <b>公开频道、公开群组、私密频道、私密群组</b> 的消息内容。\n\n' +
    '👉<a href="' + START_HELP_URL + '">点此查看如何复制消息链接</a>'
  );
}

async function sendMessage(chatId, text, parseMode = 'HTML', options = {}) {
  const url = `http://127.0.0.1:8081/bot${BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  };
  if (!options.noReplyKeyboard) {
    payload.reply_markup = options.replyMarkup || defaultReplyKeyboard();
  }
  return axios.post(url, payload);
}

async function sendPhoto(chatId, bufferOrPath, caption, options = {}) {
  const url = `http://127.0.0.1:8081/bot${BOT_TOKEN}/sendPhoto`;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  if (options.replyMarkup) form.append('reply_markup', JSON.stringify(options.replyMarkup));
  if (Buffer.isBuffer(bufferOrPath)) {
    form.append('photo', bufferOrPath, { filename: 'qr.png', contentType: 'image/png' });
  } else {
    form.append('photo', fs.createReadStream(bufferOrPath));
  }
  return axios.post(url, form, { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity });
}

async function pollQrAuth(chatId, sessionId) {
  // Poll QR auth status for up to 90 seconds
  const maxMs = 90000;
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await telegramService.checkQRCodeStatus(sessionId);
      if (r && r.authenticated) {
        chatSessions[String(chatId)] = sessionId;
        await saveChatSessions();
        await sendMessage(chatId, '登录成功，之后发送链接将使用你的专属会话下载。');
        return;
      }
    } catch (_) { /* ignore until timeout */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  await sendMessage(chatId, '二维码超时，请发送 /login 重新生成。');
}

async function sendVideo(chatId, filePath, caption, meta = {}, onProgress) {
  const url = `http://127.0.0.1:8081/bot${BOT_TOKEN}/sendVideo`;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  // attach file stream and report progress by counting read bytes
  const stat = fs.statSync(filePath);
  const total = meta.size || stat.size;
  const videoStream = fs.createReadStream(filePath);
  if (typeof onProgress === 'function' && Number.isFinite(total)) {
    let uploaded = 0;
    videoStream.on('data', (chunk) => {
      uploaded += chunk.length;
      try { onProgress(uploaded, total); } catch (_) {}
    });
  }
  form.append('video', videoStream, { filename: path.basename(filePath) });
  form.append('supports_streaming', 'true');
  if (caption) form.append('caption', caption);
  if (meta.duration) form.append('duration', String(meta.duration));
  if (meta.width) form.append('width', String(meta.width));
  if (meta.height) form.append('height', String(meta.height));
  if (meta.thumbBuffer && Buffer.isBuffer(meta.thumbBuffer)) {
    form.append('thumbnail', meta.thumbBuffer, { filename: 'thumb.jpg', contentType: 'image/jpeg' });
  }
  // Attach persistent reply keyboard too
  form.append('reply_markup', JSON.stringify(defaultReplyKeyboard()));
  // Axios in Node.js doesn't expose onUploadProgress reliably.
  // We count file bytes via the videoStream 'data' event above.
  // Just POST the form as-is.
  return axios.post(url, form, { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity });
}

async function sendVideoByUrl(chatId, fileUrl, caption, meta = {}) {
  const url = `http://127.0.0.1:8081/bot${BOT_TOKEN}/sendVideo`;
  const payload = { chat_id: chatId, video: fileUrl, supports_streaming: true };
  if (caption) payload.caption = caption;
  if (meta.duration) payload.duration = meta.duration;
  if (meta.width) payload.width = meta.width;
  if (meta.height) payload.height = meta.height;
  payload.reply_markup = defaultReplyKeyboard();
  // Let Telegram fetch the file from our HTTPS URL; avoids local upload limits
  return axios.post(url, payload);
}

async function sendDocumentByUrl(chatId, fileUrl, caption, filename) {
  const url = `http://127.0.0.1:8081/bot${BOT_TOKEN}/sendDocument`;
  const payload = { chat_id: chatId, document: fileUrl };
  // Keep caption as-is; if unset, use filename for readability
  if (caption) payload.caption = caption; else if (filename) payload.caption = filename;
  return axios.post(url, payload);
}

function scheduleDelete(filePath, delayMin = BOT_KEEP_FILE_MINUTES) {
  const delayMs = Math.max(1, delayMin) * 60 * 1000;
  setTimeout(() => {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
  }, delayMs).unref?.();
}

async function editMessage(chatId, messageId, text, parseMode = 'HTML') {
  const url = `http://127.0.0.1:8081/bot${BOT_TOKEN}/editMessageText`;
  return axios.post(url, { chat_id: chatId, message_id: messageId, text, parse_mode: parseMode, disable_web_page_preview: true });
}

async function deleteMessage(chatId, messageId) {
  const url = `http://127.0.0.1:8081/bot${BOT_TOKEN}/deleteMessage`;
  return axios.post(url, { chat_id: chatId, message_id: messageId });
}

// --------- Per-message edit queue to avoid 429 and racing edits ---------
// key: `${chatId}:${messageId}` => { lastAt, running, queue: string[] }
const editQueues = new Map();
// 记录当前每个 chat 的追踪进度消息ID，便于完成后删除或在“不可编辑”时切换
const progressTracker = new Map(); // chatId -> messageId
const EDIT_MIN_INTERVAL_MS = 1000; // at least 1s between edits per message
const EDIT_MAX_RETRY = 3; // retry when Telegram rejects edit
const PROG_DEBUG = process.env.BOT_PROGRESS_DEBUG === '1';
const MAX_QUEUE_SIZE = 12; // 防止无限堆积

async function tryDeleteProgressMessage(chatId, fallbackId, attempts = 3) {
  // 组合可能的消息ID：当前跟踪ID + 初始ID
  const ids = new Set();
  try { const tracked = progressTracker.get(chatId); if (tracked) ids.add(tracked); } catch (_) {}
  if (fallbackId) ids.add(fallbackId);
  if (ids.size === 0) return;
  for (let i = 0; i < attempts; i++) {
    for (const id of ids) {
      try {
        const r = await deleteMessage(chatId, id);
        if (process.env.BOT_PROGRESS_DEBUG === '1') {
          try { console.log(`[DEL] chat ${chatId} msg ${id} -> ${(r && r.data && r.data.ok) ? 'ok' : 'resp'}`); } catch (_) {}
        }
        if (!r || (r.data && r.data.ok)) { return; }
      } catch (e) {
        const desc = e?.response?.data?.description || '';
        // 如果已经不存在/无法删除，视为已清理；避免残留重试
        if (typeof desc === 'string' && (desc.includes('message to delete not found') || desc.includes("can't be deleted"))) {
          return;
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }
    await new Promise(r => setTimeout(r, 800));
  }
}

async function queueEdit(chatId, messageId, text) {
  const key = `${chatId}:${messageId}`;
  let state = editQueues.get(key);
  if (!state) {
    state = { lastAt: 0, running: false, queue: [], chatId, messageId, failCount: 0, lastText: '' };
    editQueues.set(key, state);
    try { progressTracker.set(chatId, messageId); } catch (_) {}
  }
  // Collapse to最新，并限制队列长度
  if (state.lastText === text && state.queue.length === 0) {
    return;
  }
  state.queue.push(text);
  if (state.queue.length > MAX_QUEUE_SIZE) state.queue.splice(0, state.queue.length - 1);
  if (PROG_DEBUG) {
    try { console.log(`[QUEUE] chat ${chatId} msg ${messageId} size=${state.queue.length}`); } catch (_) {}
  }
  if (!state.running) processEditQueue(key).catch(() => {});
}

function getTrackedMessageId(chatId, fallbackId) {
  const id = progressTracker.get(chatId);
  return id || fallbackId || null;
}

async function processEditQueue(initialKey) {
  let key = initialKey;
  const state = editQueues.get(key);
  if (!state) return;
  state.running = true;
  try {
    while (state.queue.length) {
      // Keep only the newest payload to reduce pressure
      const text = state.queue[state.queue.length - 1];
      state.queue.length = 0;
      const wait = Math.max(0, state.lastAt + EDIT_MIN_INTERVAL_MS - Date.now());
      if (wait) await new Promise(r => setTimeout(r, wait));
      try {
        if (PROG_DEBUG) console.log(`[EDIT] chat ${state.chatId} msg ${state.messageId} try`);
        const r = await editMessage(state.chatId, state.messageId, text);
        if (PROG_DEBUG) console.log(`[EDIT] ok chat ${state.chatId} msg ${state.messageId}`);
        state.failCount = 0;
      } catch (e) {
        state.failCount = (state.failCount || 0) + 1;
        if (PROG_DEBUG) console.log(`[EDIT] fail chat ${state.chatId} msg ${state.messageId} attempt ${state.failCount}: ${e?.response?.status || ''} ${e?.response?.data ? JSON.stringify(e.response.data) : e?.message || e}`);
        const desc = e?.response?.data?.description || '';
        // Telegram: Bad Request: message can't be edited -> 改为新发一条卡片，并切换跟踪的 messageId
        if (typeof desc === 'string' && desc.includes("message can't be edited")) {
          try {
            const sent = await sendMessage(state.chatId, text, 'HTML', { noReplyKeyboard: true });
            const newId = sent?.data?.result?.message_id;
            if (newId) {
              try { await deleteMessage(state.chatId, state.messageId); } catch (_) {}
              const oldKey = key;
              state.messageId = newId;
              key = `${state.chatId}:${state.messageId}`;
              editQueues.set(key, state);
              if (oldKey !== key) editQueues.delete(oldKey);
              try { progressTracker.set(state.chatId, state.messageId); } catch (_) {}
              if (PROG_DEBUG) console.log(`[EDIT] switched to new message ${key}`);
              state.failCount = 0;
              continue; // 下一轮用新 messageId 继续
            }
          } catch (_) {}
        }
        if (typeof desc === 'string' && desc.includes('message is not modified')) {
          state.failCount = 0;
          state.lastAt = Date.now();
          continue;
        }
        if (state.failCount < EDIT_MAX_RETRY) {
          // requeue newest payload and backoff
          state.queue.push(text);
          await new Promise(r => setTimeout(r, EDIT_MIN_INTERVAL_MS + 500));
        } else {
          state.failCount = 0; // reset to avoid permanently stuck
        }
      }
      state.lastAt = Date.now();
      state.lastText = text;
    }
  } finally {
    state.running = false;
  }
}


// ---------- Fancy progress formatting ----------
function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  try {
    if (typeof v.toJSNumber === 'function') return v.toJSNumber();
    if (typeof v.toNumber === 'function') return v.toNumber();
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  } catch (_) {}
  const s = (v && v.toString) ? v.toString() : `${v}`;
  const n2 = parseFloat(s);
  return Number.isFinite(n2) ? n2 : 0;
}

function prettyMB(bytes) {
  const n = toNum(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
function prettySpeed(bps) {
  const n = Number(bps || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  const mbps = n / (1024 * 1024);
  if (mbps >= 0.1) return `${mbps.toFixed(2)} MB/s`;
  const kbps = n / 1024;
  return `${kbps.toFixed(0)} KB/s`;
}
function formatETA(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}
function makeBar(percent) {
  const width = 22; // characters
  const p = Math.max(0, Math.min(100, percent || 0));
  const filled = Math.round((p / 100) * width);
  const bar = '▰'.repeat(filled) + '▱'.repeat(Math.max(0, width - filled));
  return `${bar}  ${p.toFixed(2)} %`;
}
function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function makeProgressTemplate({ link, stage = 'download', index = 1, totalCount = 1, fileName, received = 0, total = 0, status = '', speedText = '', percentOverride = null }) {
  // stage: 'download' -> 样式1（正在提取/已提取）；'send' -> 样式2（正在上传/已上传）
  const top = stage === 'download' ? '📥 正在提取' : '📬 正在上传';
  const bottom = stage === 'download' ? '🖨️ 已提取：' : '🚀 已上传：';
  const r = toNum(received);
  const t = toNum(total);
  const percent = (typeof percentOverride === 'number' && Number.isFinite(percentOverride))
    ? Math.max(0, Math.min(100, percentOverride))
    : (t ? (r / t) * 100 : 0);
  const bar = makeBar(percent);
  const name = escapeHtml(fileName || '获取文件名中…');
  const ln = escapeHtml(link || '');
  const recv = prettyMB(r);
  const tot = t ? prettyMB(t) : '未知';
  return (
    `${ln}\n` +
    `📦 ${top}${status ? ' ' + status : ''}第 ${index}/${totalCount} 个文件\n\n` +
    `📁 <code>${name}</code>\n\n` +
    `${bar}\n` +
    (speedText ? `\n${speedText}\n` : '\n') +
    `${bottom} <b>${recv}</b> / <b>${tot}</b>`
  );
}

// Simple t.me link parser
function parseTelegramLink(text) {
  if (!text) return null;
  const urlMatch = text.match(/https?:\/\/t\.me\/(.+)$/i);
  if (!urlMatch) return null;
  const rest = urlMatch[1];
  // t.me/c/123456/789
  let m = rest.match(/^c\/(\d+)\/(\d+)/);
  if (m) {
    return { type: 'internal', chat: m[1], msgId: parseInt(m[2], 10) };
  }
  // t.me/username/789
  m = rest.match(/^([A-Za-z0-9_]{4,})\/(\d+)/);
  if (m) {
    return { type: 'username', chat: m[1], msgId: parseInt(m[2], 10) };
  }
  return null;
}

// Webhook to receive bot updates (push)
router.post('/webhook', async (req, res) => {
  if (!assertBotConfigured(res)) return;
  // Optional secret verification (Telegram sends X-Telegram-Bot-Api-Secret-Token)
  if (BOT_SECRET) {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (secret !== BOT_SECRET) {
      return res.status(401).json({ error: 'invalid secret' });
    }
  }
  const update = req.body || {};
  res.status(200).json({ ok: true }); // respond fast to Telegram

  try {
    // Handle inline button callbacks
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data || '';
      const chatId = cb.message?.chat?.id;
      const messageId = cb.message?.message_id;
      const api = `http://127.0.0.1:8081/bot${BOT_TOKEN}/answerCallbackQuery`;
      try { await axios.post(api, { callback_query_id: cb.id }); } catch (_) {}
      if (data === 'invite') {
        await sendMessage(chatId, '邀请功能：把机器人分享给好友即可使用～');
      } else if (data === 'topup') {
        await sendMessage(chatId, '充值功能：暂未开通，敬请期待。');
      } else if (data === 'me') {
        await sendMessage(chatId, '我的：发送 /status 查看当前下载进度，/cancel 取消任务。');
      }
      return;
    }
    const msg = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
    if (!msg || (!msg.text && !msg.caption)) return;
    const chatId = msg.chat?.id;
    const text = msg.text || msg.caption || '';
    const trimmed = text.trim();
    // Login state store (in-memory)
    if (!global._botLoginStates) global._botLoginStates = new Map();
    const loginState = global._botLoginStates;
    // Handle simple commands
    if (/^\/start\b/.test(trimmed) || /^\/menu\b/.test(trimmed)) {
      // Send the welcome message with inline keyboard; keep existing reply keyboard persistent
      await sendMessage(chatId, getStartMessageText(), 'HTML', { replyMarkup: startInlineKeyboard() });
      return;
    }
    if (trimmed === CMD_LOGIN) {
      const base = BOT_WEB_LOGIN_URL || process.env.PUBLIC_BASE_URL || '';
      const finalBase = base && base.startsWith('http') ? base : 'https://dltelegram.com';
      // When BOT_BIND_SECRET is set, pass it via query so web can authorize /api/bot/bindChat
      const secretPart = BOT_BIND_SECRET ? `&secret=${encodeURIComponent(BOT_BIND_SECRET)}` : '';
      const url = `${finalBase}${finalBase.includes('?') ? '&' : '?'}botChatId=${encodeURIComponent(chatId)}${secretPart}`;
      const html = `为了账号安全，请在网页中完成手机号登录并输入验证码：\n<a href=\"${url}\">打开登录页</a>\n\n登录成功后，网页会自动把本聊天绑定到你的会话，之后在这里发送链接即可下载。`;
      try { await sendMessage(chatId, html, 'HTML'); }
      catch (_) { await sendMessage(chatId, `为了账号安全，请在网页中完成手机号登录并输入验证码：\n${url}\n\n登录成功后，网页会自动把本聊天绑定到你的会话，之后在这里发送链接即可下载。`); }
      return;
    }
    if (trimmed === CMD_LOGOUT) {
      delete chatSessions[String(chatId)];
      await saveChatSessions();
      await sendMessage(chatId, '已清除与此聊天绑定的会话。');
      return;
    }
    if (trimmed === BTN_INVITE) {
      await sendMessage(chatId, '邀请功能：把机器人分享给好友即可使用～');
      return;
    }
    if (trimmed === BTN_TOPUP) {
      await sendMessage(chatId, '充值功能：暂未开通，敬请期待。');
      return;
    }
    if (trimmed === BTN_ME) {
      await sendMessage(chatId, '我的：发送 /status 查看当前下载进度，/cancel 取消任务。');
      return;
    }
    if (/^\/cancel\b/.test(trimmed)) {
      const t = activeTasks.get(chatId);
      if (t) { t.cancel = true; await sendMessage(chatId, '已发送取消请求，正在停止下载…'); }
      else { await sendMessage(chatId, '当前没有正在进行的下载任务。'); }
      return;
    }
    if (/^\/status\b/.test(trimmed)) {
      const t = activeTasks.get(chatId);
      if (t && t.total) {
        const pct = Math.floor((t.current / t.total) * 100);
        await sendMessage(chatId, `下载进度：${pct}% (${(t.current/1048576).toFixed(1)}/${(t.total/1048576).toFixed(1)} MB)`);
      } else {
        await sendMessage(chatId, '暂无进行中的下载任务。');
      }
      return;
    }
    // For security, prohibit entering codes in chat; guide to QR/web
    const state = loginState.get(chatId);
    if (state && (state.step === 'await_phone' || state.step === 'await_code' || state.step === 'await_2fa')) {
      await sendMessage(chatId, '为保护你的账号安全，请使用二维码登录，或点击消息中的“使用网页手机号登录”在网页中输入验证码。');
      return;
    }

    const parsed = parseTelegramLink(text);
    if (!parsed) {
      if (chatId) await sendMessage(chatId, '请发送 Telegram 消息链接，例如 https://t.me/<用户名>/<消息ID> 或 https://t.me/c/<内部ID>/<消息ID>');
      return;
    }

    const sessionId = await getWorkingSessionId(chatId);
    if (!sessionId) {
      if (chatId) await sendMessage(chatId, '后端尚未登录 Telegram 用户会话，无法读取频道消息');
      return;
    }

    // Warm up sandbox early to avoid cold-start latency (no-op if exists)
    try { if (chatId && sessionId) sandboxManager.ensureSandbox(chatId, sessionId); } catch (_) {}

    // Pre-fetch meta (file name, size) for nicer progress card.
    // When eager mode is on, don't wait for meta here to avoid startup delay.
    let meta = null;
    if (!BOT_EAGER_START) {
      meta = await telegramService.getMessageMetaFromLink(sessionId, text).catch(() => null);
    }

    // 先发送初始进度卡片，随后将任务入队，真正的下载在后台 Worker 中执行
    let progressMsgId = null;
    if (chatId) {
      const initial = makeProgressTemplate({
        link: text,
        stage: 'download',
        index: 1,
        totalCount: 1,
        fileName: meta?.displayName,
        received: 0,
        total: meta?.size || 0,
      });
      const sent = await sendMessage(chatId, initial, 'HTML', { noReplyKeyboard: true });
      progressMsgId = sent?.data?.result?.message_id || null;

      // 即使启用了 BOT_EAGER_START（跳过阻塞式 meta 获取），也在后台并行获取
      // 元数据，拿到后立刻刷新进度卡片以显示 文件名/总大小。
      if (!meta) {
        (async () => {
          try {
            const m = await telegramService.getMessageMetaFromLink(await getWorkingSessionId(chatId), text).catch(() => null);
            if (m && progressMsgId) {
              // 更新初始卡片，补充文件名与总大小
              let card = makeProgressTemplate({
                link: text,
                stage: 'download',
                index: 1,
                totalCount: 1,
                fileName: m.displayName,
                received: 0,
                total: m.size || 0,
              });
              try { card += (Date.now() % 2 === 0 ? '\u2063' : '\u2060'); } catch (_) {}
              queueEdit(chatId, progressMsgId, card).catch(() => {});
              // 将 meta 写回，便于后续发送阶段使用
              meta = m;
            }
          } catch (_) {}
        })();
      }
    }

    // 额度与限额校验与预扣
    const user = await userStore.getOrCreate(chatId);
    // 是否允许私密
    if (!user.allowPrivate) {
      const isPrivate = !/https?:\/\/t\.me\//.test('') || true; // 真实判断在下载时才能确知；此处仅按计划限制文本提示
    }
    const sizeLimit = user.maxFileBytes || Infinity;
    if (!BOT_EAGER_START) {
      if (meta && meta.size && Number(meta.size) > sizeLimit) {
        await sendMessage(chatId, `你的套餐单文件上限为 ${(sizeLimit/1024/1024).toFixed(0)}MB，此文件超限，已跳过。`);
        return;
      }
    }
    const ok = await userStore.reserveDaily(chatId);
    if (!ok) {
      await sendMessage(chatId, '今日额度已用尽，明日再试或升级套餐。');
      return;
    }
    // 大文件额度：私域>10MB计一次
    let consumeBig = 0;
    if (!BOT_EAGER_START) {
      if (meta && meta.size && Number(meta.size) > 10 * 1024 * 1024) consumeBig = 1;
    }

    const taskPayload = {
      chatId,
      sessionId,
      link: text,
      progressMsgId,
      meta: meta && typeof meta === 'object' ? meta : null,
      consumeBig,
      enqueuedAt: Date.now()
    };
    // Fast start: if启用且当前 chat 未上锁，直接在本进程启动下载；否则入队
    if (BOT_FAST_START) {
      try {
        const locked = await acquireChatLock(chatId);
        if (locked) {
          // 后台异步执行，避免阻塞 webhook；锁在任务完成后释放
          (async () => {
            try { await processQueuedTask(taskPayload); }
            finally { try { await releaseChatLock(chatId); } catch (_) {} }
          })();
          return;
        }
      } catch (_) { /* fall back to queue */ }
    }

    try { await redis.lpush(QUEUE_KEY, JSON.stringify(taskPayload)); } catch (_) {}
    return; // 已入队
  } catch (err) {
    try {
      const chatId = req.body?.message?.chat?.id;
      if (chatId) await sendMessage(chatId, `下载失败：${err?.message || '未知错误'}`);
      activeTasks.delete(chatId);
    } catch (_) {}
    console.error('Bot webhook error:', err);
  }
});

// Helper endpoints to manage webhook from VPS quickly
router.post('/setWebhook', async (req, res) => {
  if (!assertBotConfigured(res)) return;
  const { url } = req.body || {};
  const hookUrl = url || process.env.BOT_WEBHOOK_URL;
  if (!hookUrl) return res.status(400).json({ error: 'missing url' });
  try {
    const api = `http://127.0.0.1:8081/bot${BOT_TOKEN}/setWebhook`;
    const payload = { url: hookUrl };
    if (BOT_SECRET) payload.secret_token = BOT_SECRET;
    const r = await axios.post(api, payload);
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/deleteWebhook', async (req, res) => {
  if (!assertBotConfigured(res)) return;
  try {
    const api = `http://127.0.0.1:8081/bot${BOT_TOKEN}/deleteWebhook`;
    const r = await axios.post(api, { drop_pending_updates: false });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bind a web-authenticated session to a bot chat
// POST /api/bot/bindChat { chatId, sessionId }
router.post('/bindChat', async (req, res) => {
  try {
    const { chatId, sessionId } = req.body || {};
    if (!chatId || !sessionId) return res.status(400).json({ error: 'chatId and sessionId required' });
    if (process.env.BOT_BIND_SECRET) {
      const token = req.headers['x-bot-bind-secret'] || req.query.secret;
      if (token !== process.env.BOT_BIND_SECRET) return res.status(401).json({ error: 'unauthorized' });
    }
    const s = await sessionStore.get(sessionId);
    if (!s || !(s.sessionString || s.stringSession) || s.authenticated !== true) {
      return res.status(400).json({ error: 'session not authenticated' });
    }
    chatSessions[String(chatId)] = sessionId;
    await saveChatSessions();
    try { await sendMessage(chatId, '登录成功，已将此聊天绑定到你的会话。'); } catch (_) {}
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// In-memory task map: chatId -> { cancel, current, total, startedAt, link, filePath, messageId }
const activeTasks = new Map();

// Admin: list tasks
router.get('/tasks', (req, res) => {
  const list = [];
  for (const [chatId, t] of activeTasks.entries()) {
    list.push({ chatId, cancel: t.cancel, current: t.current, total: t.total, startedAt: t.startedAt, link: t.link });
  }
  res.json({ tasks: list });
});

// Admin: cancel by chatId
router.post('/cancel', (req, res) => {
  const { chatId } = req.body || {};
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  const t = activeTasks.get(Number(chatId)) || activeTasks.get(String(chatId));
  if (!t) return res.json({ ok: true, message: 'no active task' });
  t.cancel = true;
  return res.json({ ok: true, message: 'cancel flag set' });
});

module.exports = router;
// (no copyFromChannel in this version)

// ---------------- Queue consumer with per-chat lock & watchdog retry ----------------
async function acquireChatLock(chatId) {
  try {
    const key = LOCK_PREFIX + String(chatId);
    const ok = await redis.set(key, String(Date.now()), 'NX', 'EX', LOCK_TTL_SEC);
    return !!ok;
  } catch (_) { return false; }
}

async function releaseChatLock(chatId) {
  try { await redis.del(LOCK_PREFIX + String(chatId)); } catch (_) {}
}

async function processQueuedTask(task) {
  const chatId = task.chatId;
  const sessionId = task.sessionId;
  const text = task.link;
  let meta = task.meta || null;
  let metaPromise = null;
  const progressMsgId = task.progressMsgId || null;

  try {
    // 如果没有 meta，后台并行拉取（不阻塞开始下载），便于后续显示总大小
    if (!meta) {
      try {
        metaPromise = telegramService.getMessageMetaFromLink(sessionId, text)
          .then((m) => { meta = m; return m; })
          .catch(() => null);
      } catch (_) { metaPromise = null; }
    }

    const tmpDir = path.join(process.cwd(), 'downloads', 'bot');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpName = `dl_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`;
    const target = path.join(tmpDir, tmpName);

    const taskState = { cancel: false, current: 0, total: 0, startedAt: Date.now(), link: text };
    activeTasks.set(chatId, taskState);

    let lastBytes = 0;
    let speedAvgBps = 0;
    let lastSpeedTs = Date.now();
    let lastSpeedBytes = 0;
    // 用于统一估算总大小：优先使用下载器提供的 total，其次使用 meta.size
    let estTotal = Number(meta?.size || 0) || 0;
    let lastTs = Date.now();
    let result = null;
    const maxRetry = Math.max(0, DOWNLOAD_MAX_RETRY);

    // 预热阶段：在真正的下载进度出现前，用一个小旋转标记告诉用户“正在准备”
    let progressStarted = false;
    let spinIdx = 0;
    const SPIN = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    const preTicker = progressMsgId ? setInterval(() => {
      try {
        if (progressStarted) return;
        let t = Number(meta?.size || 0);
        let card = makeProgressTemplate({
          link: text,
          stage: 'download',
          index: 1,
          totalCount: 1,
          fileName: meta?.displayName || '获取文件名中…',
          received: 0,
          total: t,
          status: `${SPIN[spinIdx++ % SPIN.length]} 准备中…`
        });
        try { card += (Date.now() % 2 === 0 ? '\u2063' : '\u2060'); } catch (_) {}
        queueEdit(chatId, progressMsgId, card).catch(() => {});
      } catch (_) {}
    }, 900) : null;

    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      let stalledTriggered = false;
      const watchdog = setInterval(() => {
        try {
          if (Date.now() - lastTs > WATCHDOG_IDLE_MS) {
            stalledTriggered = true;
            if (process.env.BOT_PROGRESS_DEBUG === '1') console.log(`[EDIT] watchdog stall chat ${chatId}, destroying sandbox`);
            try { sandboxManager.destroySandbox(chatId); } catch (_) {}
          }
        } catch (_) {}
      }, 5000);
      // Cancellation watcher: user may send /cancel anytime
      const cancelWatcher = setInterval(() => {
        try {
          const st = activeTasks.get(chatId);
          if (st && st.cancel) {
            if (process.env.BOT_PROGRESS_DEBUG === '1') console.log(`[CANCEL] chat ${chatId} requested, destroying sandbox`);
            try { sandboxManager.destroySandbox(chatId); } catch (_) {}
          }
        } catch (_) {}
      }, 600);

      try {
        result = await sandboxManager.enqueueDownload(
          chatId,
          sessionId,
          text,
          (received, total) => {
            try { if (process.env.BOT_PROGRESS_DEBUG === '1') console.log(`[PROG] chat ${chatId} recv=${received} total=${total}`); } catch(_) {}
            lastTs = Date.now();
            progressStarted = true;
            // Honor cancellation immediately
            try { const st = activeTasks.get(chatId); if (st && st.cancel) return false; } catch (_) {}
            // 统一估算总大小
            if (typeof total === 'number' && total > 1) estTotal = Number(total);
            if (!estTotal && meta?.size) estTotal = Number(meta.size) || 0;

            // 规范化 received：既兼容字节数也兼容 [0,1] 比例
            let r = Number(received || 0);
            let percentOverride = null;
            if ((r > 0 && r <= 1) && estTotal > 0) {
              r = Math.floor(estTotal * r);
            } else if ((r > 0 && r <= 1) && (!estTotal || estTotal <= 1)) {
              // 尚未知总大小时，先用比例直接驱动进度条，避免视觉“长时间 0%”
              percentOverride = r * 100;
            }
            if (typeof r === 'number' && r > lastBytes) lastBytes = r;
            if (!progressMsgId) return;
            let t = Number(total || 0);
            if (!t || t <= 1) t = estTotal || 0;
            // Clamp: 不允许显示“已提取 > 总大小”
            if (t && t > 1 && r > t) r = t;
            // 计算速度与 ETA（指数平滑）
            let speedText = '';
            try {
              const now2 = Date.now();
              const dt = now2 - lastSpeedTs;
              if (dt >= 400) {
                const diff = Math.max(0, r - lastSpeedBytes);
                const inst = diff / (dt / 1000);
                speedAvgBps = speedAvgBps ? (0.7 * speedAvgBps + 0.3 * inst) : inst;
                lastSpeedTs = now2; lastSpeedBytes = r;
              }
              if (speedAvgBps > 0) {
                const remain = t && t > 0 ? Math.max(0, t - r) : 0;
                const eta = remain && speedAvgBps ? remain / speedAvgBps : 0;
                const s = prettySpeed(speedAvgBps);
                speedText = s ? `⚡ ${s}${eta ? ` · 剩余 ${formatETA(eta)}` : ''}` : '';
              }
            } catch (_) {}
            // 记录给 /status 使用
            try { const st = activeTasks.get(chatId); if (st) { st.current = r; st.total = t || st.total || 0; } } catch (_) {}
  let textCard = makeProgressTemplate({
              link: text,
              stage: 'download',
              index: 1,
              totalCount: 1,
              fileName: meta?.displayName || '获取文件名中…',
              received: r,
              total: t,
              speedText,
              percentOverride,
            });
  // 为避免 Telegram 报 "message is not modified"，在文本末尾附加不可见字符作“心跳”
  try { textCard += (Date.now() % 2 === 0 ? '\u2063' : '\u2060'); } catch (_) {}
  queueEdit(chatId, progressMsgId, textCard).catch(() => {});
          }
        );
        clearInterval(watchdog);
        clearInterval(cancelWatcher);
        if (preTicker) { try { clearInterval(preTicker); } catch (_) {} }
        break; // success
      } catch (e) {
        clearInterval(watchdog);
        clearInterval(cancelWatcher);
        if (preTicker) { try { clearInterval(preTicker); } catch (_) {} }
        // Cancellation: do not retry, clean up and notify
        const em = (e && e.message) ? String(e.message) : '';
        if (/cancelled|destroyed/i.test(em)) {
          try { await tryDeleteProgressMessage(chatId, progressMsgId, 3); } catch (_) {}
          try { progressTracker.delete(chatId); } catch (_) {}
          try { await sendMessage(chatId, '已取消当前下载任务。'); } catch (_) {}
          activeTasks.delete(chatId);
          return; // stop processing
        }
        if (attempt >= maxRetry) throw e;
        // 小退避后重试
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    // 发送阶段：优先直传 multipart，失败回退 URL
    const publicBase = process.env.PUBLIC_BASE_URL || (process.env.BOT_WEBHOOK_URL ? new URL(process.env.BOT_WEBHOOK_URL).origin : '');
    const publicPath = `/bot/${path.basename(result.filePath)}`;
    const publicUrl = publicBase ? `${publicBase}${publicPath}` : publicPath;

    // 若在下载完成后才收到取消请求，则直接终止发送并清理
    try { const st = activeTasks.get(chatId); if (st && st.cancel) { try { await tryDeleteProgressMessage(chatId, progressMsgId, 3); } catch(_) {} ; activeTasks.delete(chatId); try { fs.unlinkSync(result.filePath); } catch(_) {}; try { await sendMessage(chatId, '已取消当前下载任务。'); } catch(_) {}; return; } } catch (_) {}

    let sendRes;
    let uploadedLocal = false;
    try {
      let lastUpPct = 0; let lastUpTs = 0;
      let upSpeedAvgBps = 0; let lastUpBytesVal = 0; let lastUpSpeedTs = Date.now();
      let thumbBuffer = null;
      try { thumbBuffer = await telegramService.getThumbnailFromMessageLink(sessionId, text, 'm'); } catch (_) {}

      sendRes = await sendVideo(
        chatId,
        result.filePath,
        result.displayName || result.fileName || '视频',
        { duration: result.duration, width: result.width, height: result.height, size: result.size, thumbBuffer },
        (sentBytes, totalBytes) => {
          const now = Date.now();
          const pct = totalBytes ? (sentBytes / totalBytes) * 100 : 0;
          if (pct >= lastUpPct + 1 || now - lastUpTs > 1500) {
            lastUpPct = pct; lastUpTs = now;
            if (progressMsgId) {
              // 上传速度与 ETA
              let upText = '';
              try {
                const dt = now - lastUpSpeedTs;
                if (dt >= 400) {
                  const diff = Math.max(0, sentBytes - lastUpBytesVal);
                  const inst = diff / (dt / 1000);
                  upSpeedAvgBps = upSpeedAvgBps ? (0.7 * upSpeedAvgBps + 0.3 * inst) : inst;
                  lastUpSpeedTs = now; lastUpBytesVal = sentBytes;
                }
                if (upSpeedAvgBps > 0) {
                  const remain = totalBytes && totalBytes > 0 ? Math.max(0, totalBytes - sentBytes) : 0;
                  const eta = remain && upSpeedAvgBps ? remain / upSpeedAvgBps : 0;
                  const s = prettySpeed(upSpeedAvgBps);
                  upText = s ? `⚡ ${s}${eta ? ` · 剩余 ${formatETA(eta)}` : ''}` : '';
                }
              } catch (_) {}
          let card = makeProgressTemplate({
                link: text,
                stage: 'send',
                index: 1,
                totalCount: 1,
                fileName: result.displayName || result.fileName,
                received: totalBytes && sentBytes > totalBytes ? totalBytes : sentBytes,
                total: totalBytes,
                speedText: upText
              });
              try { const st = activeTasks.get(chatId); if (st) { st.current = totalBytes && sentBytes > totalBytes ? totalBytes : sentBytes; st.total = totalBytes || st.total || 0; } } catch (_) {}
              try { card += (Date.now() % 2 === 0 ? '\u2063' : '\u2060'); } catch (_) {}
              const trackedId = getTrackedMessageId(chatId, progressMsgId);
              if (trackedId) {
                queueEdit(chatId, trackedId, card).catch(() => {});
              }
            }
          }
        }
      );
      uploadedLocal = true;
    } catch (_) {
      try {
        sendRes = await sendVideoByUrl(chatId, publicUrl, result.displayName || result.fileName || '视频', {
          duration: result.duration,
          width: result.width,
          height: result.height,
        });
      } catch (e2) {
        sendRes = await sendDocumentByUrl(chatId, publicUrl, result.displayName || result.fileName || '视频', path.basename(result.filePath));
      }
    }

    if (sendRes?.data?.ok && uploadedLocal) {
      try { fs.unlinkSync(result.filePath); } catch (_) {}
    }
    if (sendRes?.data?.ok && !uploadedLocal) {
      scheduleDelete(result.filePath);
    }
    if (sendRes?.data?.ok) {
      try { await tryDeleteProgressMessage(chatId, progressMsgId, 4); } catch (_) {}
      try { progressTracker.delete(chatId); } catch (_) {}
    }
    if (!sendRes?.data?.ok) {
      try { await sendMessage(chatId, `发送失败：${sendRes?.data?.description || '未知错误'}`); } catch (_) {}
    }
    activeTasks.delete(chatId);
    // 扣减大文件额度（仅成功才扣）。若 webhook 阶段未拿到 meta，则根据实际文件大小判断。
    try {
      const bigByResult = (result && result.size && Number(result.size) > 10 * 1024 * 1024) ? 1 : 0;
      const toConsume = task.consumeBig ? task.consumeBig : bigByResult;
      if (toConsume) await userStore.consumeBigFileCredit(chatId, toConsume);
    } catch (_) {}
  } catch (e) {
    try { await sendMessage(task.chatId, `下载失败：${e?.message || '未知错误'}`); } catch (_) {}
    activeTasks.delete(task.chatId);
    try { await userStore.refundDaily(chatId); } catch (_) {}
  }
}

async function consumeQueue() {
  // 后台常驻消费队列
  while (true) {
    try {
      const item = await redis.brpop(QUEUE_KEY, 5);
      if (!item || !Array.isArray(item) || !item[1]) continue;
      let task; try { task = JSON.parse(item[1]); } catch (_) { task = null; }
      if (!task || !task.chatId) continue;
      const locked = await acquireChatLock(task.chatId);
      if (!locked) {
        // 该 chat 正在被其他实例处理，放回队列尾部
        try { await redis.rpush(QUEUE_KEY, JSON.stringify(task)); } catch (_) {}
        await new Promise(r => setTimeout(r, 200));
        continue;
      }
      try {
        await processQueuedTask(task);
      } finally {
        await releaseChatLock(task.chatId);
      }
    } catch (_) {
      // 避免紧循环
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

setImmediate(() => {
  const n = Math.max(1, QUEUE_CONCURRENCY);
  for (let i = 0; i < n; i++) {
    try { consumeQueue(); } catch (_) {}
  }
});
// 在进程启动时预热已绑定聊天的 sandbox，以保持会话常驻并减少首包延迟
setImmediate(() => {
  try {
    const PREWARM_LIMIT = parseInt(process.env.SANDBOX_PREWARM_LIMIT || '6', 10);
    let count = 0;
    for (const [cid, sid] of Object.entries(chatSessions)) {
      if (!sid) continue;
      try {
        sandboxManager.ensureSandbox(cid, sid);
      } catch (_) {}
      if (++count >= PREWARM_LIMIT) break;
    }
  } catch (_) {}
});
