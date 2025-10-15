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
// 强制关注频道
// 可用用户名（如 '@takemsgg'）或数值 ID（如 -1003146747117）。
const FORCE_CHANNEL = '@takemsgg';
const FORCE_CHANNEL_ID = parseInt(process.env.FORCE_CHANNEL_ID || '-1003146747117', 10);
// Eager start: don't block on meta/limits at webhook stage
const BOT_EAGER_START = process.env.BOT_EAGER_START === '1';
// Fast path: skip Redis queue and start immediately when possible
const BOT_FAST_START = process.env.BOT_FAST_START === '1';
// Link for "👉点此查看如何复制消息链接"
const START_HELP_URL = process.env.BOT_START_HELP_URL || 'https://t.me/takemsgg';
const BOT_KEEP_FILE_MINUTES = parseInt(process.env.BOT_KEEP_FILE_MINUTES || '30', 10); // For URL fallback cleanup
const BOT_WEB_LOGIN_URL = process.env.BOT_WEB_LOGIN_URL || process.env.PUBLIC_BASE_URL || '';
const BOT_BIND_SECRET = process.env.BOT_BIND_SECRET || '';
// 大文件判定阈值（单位 MB），默认 10MB
const BIGFILE_THRESHOLD = (parseInt(process.env.BIGFILE_THRESHOLD_MB || '10', 10) || 10) * 1024 * 1024;
// De-duplication window for identical updates (message + edited_message etc.)
const DEDUPE_TTL_MS = parseInt(process.env.BOT_DEDUPE_TTL_MS || '60000', 10);
const _recentMsgMap = new Map(); // key: `${chatId}:${messageId}` -> lastSeenMs

function _seenRecently(chatId, messageId) {
  try {
    const key = `${chatId}:${messageId}`;
    const now = Date.now();
    const last = _recentMsgMap.get(key);
    if (last && now - last < DEDUPE_TTL_MS) return true;
    _recentMsgMap.set(key, now);
    // Lazy cleanup to keep the map bounded
    if (_recentMsgMap.size > 10000) {
      for (const [k, t] of _recentMsgMap.entries()) {
        if (now - t > DEDUPE_TTL_MS) _recentMsgMap.delete(k);
      }
    }
    return false;
  } catch (_) { return false; }
}
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

// Simple per-chat flags for onboarding etc.
const CHAT_FLAGS_PATH = path.join(process.cwd(), 'sessions', 'chatFlags.json');
let chatFlags = {};
try { chatFlags = JSON.parse(fs.readFileSync(CHAT_FLAGS_PATH, 'utf8')); } catch (_) { chatFlags = {}; }
async function saveChatFlags() {
  try {
    await fsExtra.ensureDir(path.dirname(CHAT_FLAGS_PATH));
    await fsExtra.writeJson(CHAT_FLAGS_PATH, chatFlags, { spaces: 2 });
  } catch (_) {}
}

function getFlag(chatId) {
  const key = String(chatId);
  if (!chatFlags[key]) chatFlags[key] = {};
  return chatFlags[key];
}

async function maybeSendFollowTip(chatId, force = false) {
  try {
    const f = getFlag(chatId);
    const now = Date.now();
    const TTL = 2 * 60 * 1000; // 2 min de-dup
    if (!force && f.lastFollowAt && now - f.lastFollowAt < TTL) return false;
    const tip = '📢 在使用机器人前，请先关注我们的官方频道，及时获取功能更新与重要通知！';
    await sendMessage(chatId, tip, 'HTML', { replyMarkup: followInlineKeyboard() });
    f.lastFollowAt = now;
    if (force) f.shownFollowTip = true;
    await saveChatFlags();
    return true;
  } catch (_) {
    try { await sendMessage(chatId, `请先关注我们的官方频道\n${channelUrl()}`); } catch (_) {}
    return false;
  }
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

function inviteInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '💰 收益提现', callback_data: 'invite_withdraw' }],
      [{ text: '↩️ 返回', callback_data: 'back_start' }],
    ],
  };
}

function getInviteMessageText(chatId, fromId) {
  // 优先使用 users.json 保存的 userId；否则退回到 fromId 或 chatId
  let uid = resolveUserIdFromStore(chatId) || (fromId ? String(fromId) : String(chatId));
  const invite = `https://t.me/getmsgtgbot?start=a_${uid}`;
  return (
    '邀请新用户，永久增加提取额度，赚取丰厚奖励！\n\n' +
    '专属邀请链接：电报消息提取器，破解消息转发保存限制\n' +
    `<a href="${invite}">${invite}</a>（点击可复制）\n\n` +
    '💌 每成功邀请一位好友，您的每日额度将永久 +1\n' +
    '🔥 每邀请一位好友充值，您将获得该好友充值金额的 20%'
  );
}

async function showInviteCard(chatId, fromId) {
  try {
    await sendMessage(chatId, getInviteMessageText(chatId, fromId), 'HTML', { replyMarkup: inviteInlineKeyboard() });
  } catch (_) {
    try { await sendMessage(chatId, '邀请新用户，赚取奖励！'); } catch (_) {}
  }
}

function topupInlineKeyboard() {
  return {
    inline_keyboard: [
      // 点击后直接跳转到指定的 Telegram 页面进行开通
      [{ text: '🪙 SVIP - ¥660', url: 'https://t.me/iDataRiver_Bot?start=M_68edfe987b433a6286f5b9a3' }],
      [{ text: '🚀 充值大文件额度(1000个,非开通VIP)', url: 'https://t.me/iDataRiver_Bot?start=M_68edfe987b433a6286f5b9a3' }],
      [{ text: '↩️ 返回', callback_data: 'back_start' }],
    ],
  };
}

function getTopupMessageText() {
  return (
    '升级为永久会员，尊享全部功能，体验极速提取！\n\n' +
    'SVIP会员：\n' +
    '• 每日额度不限；支持公开频道、群组、私密频道、群组、机器人消息；\n' +
    '• 提取文件大小不限；3000个大文件额度\n\n' +
    '💡 大文件额度说明：\n' +
    '• 私人频道或群组提取超过10MB的文件需要使用大文件额度（一次性额度，非每日刷新；若额度不足会自动跳过该文件）'
  );
}

async function showTopupCard(chatId) {
  try {
    await sendMessage(chatId, getTopupMessageText(), 'HTML', { replyMarkup: topupInlineKeyboard() });
  } catch (e) {
    try { await sendMessage(chatId, '升级为永久会员，尊享全部功能！'); } catch (_) {}
  }
}

function myInlineKeyboard() {
  return { inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'back_start' }]] };
}

function getPlanLabel(plan) {
  const p = String(plan || '').toLowerCase();
  if (p === 'svip') return 'SVIP 用户';
  if (p === 'vip') return 'VIP 用户';
  return '免费用户';
}

function getMyMessageText(u) {
  const planLabel = getPlanLabel(u?.plan);
  const rest = Math.max(0, Number(u?.dailyLimit || 0) - Number(u?.dailyUsed || 0));
  const limit = Number(u?.dailyLimit || 0);
  return (
    `欢迎使用消息提取器！您现在是<b>${planLabel}</b>，可体验公开频道消息提取。\n\n` +
    `<b>升级为永久 VIP，享受更多提取权限和高级功能！</b>\n` +
    `发送 <code>/recharge</code> 即可升级！\n\n` +
    `今日剩余额度：<b>${rest}</b>\n` +
    `每日可用额度：<b>${limit}</b>`
  );
}

async function showMyCard(chatId) {
  try {
    const u = await userStore.getOrCreate(chatId);
    await sendMessage(chatId, getMyMessageText(u), 'HTML', { replyMarkup: myInlineKeyboard() });
  } catch (_) {
    await sendMessage(chatId, '我的：发送 /status 查看当前下载进度，/cancel 取消任务。');
  }
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
    // Allow callers to enable web page preview explicitly
    disable_web_page_preview: options && options.preview === true ? false : true,
  };
  if (!options.noReplyKeyboard) {
    payload.reply_markup = options.replyMarkup || defaultReplyKeyboard();
  }
  return axios.post(url, payload);
}

// --- Force-subscription helpers ---
function channelUrl() {
  try { return `https://t.me/${String(FORCE_CHANNEL || '').replace(/^@/, '')}`; }
  catch (_) { return 'https://t.me/takemsgg'; }
}
function followInlineKeyboard() {
  return {
    inline_keyboard: [[{ text: '立即关注', url: channelUrl() }]],
  };
}

function resolveUserIdFromStore(chatId) {
  try {
    const USERS_PATH = path.join(process.cwd(), 'sessions', 'users.json');
    const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    const rec = data && data[String(chatId)];
    if (rec && rec.userId) return String(rec.userId);
  } catch (_) {}
  return null;
}

async function checkChannelMember(userId) {
  try {
    const url = `http://127.0.0.1:8081/bot${BOT_TOKEN}/getChatMember`;
    const chat = Number.isFinite(FORCE_CHANNEL_ID) ? FORCE_CHANNEL_ID : FORCE_CHANNEL;
    const r = await axios.post(url, { chat_id: chat, user_id: userId });
    const status = r?.data?.result?.status || '';
    const ok = status === 'member' || status === 'administrator' || status === 'creator';
    return { ok, status };
  } catch (e) {
    return { ok: null, error: e };
  }
}

async function ensureSubscribed(chatId, userId) {
  // 优先从 users.json 里按 chatId 查找；若不存在再用消息中的 from.id
  const fromStore = resolveUserIdFromStore(chatId);
  if (fromStore) userId = fromStore; else if (!userId) userId = null;
  if (!userId) {
    await maybeSendFollowTip(chatId);
    return false;
  }
  const res = await checkChannelMember(userId);
  if (res.ok === true) return true;
  if (res.ok === false) {
    await maybeSendFollowTip(chatId);
    return false;
  }
  // ok === null -> 无法校验，也按未关注处理以强制关注
  await maybeSendFollowTip(chatId);
  return false;
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
    // Ensure a final 100% tick even if最后一块不足以触发外层阈值
    videoStream.once('end', () => {
      try { onProgress(total, total); } catch (_) {}
    });
    // Some streams may emit 'close' without 'end' on error-free completion
    videoStream.once('close', () => {
      try { onProgress(total, total); } catch (_) {}
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

// Send an album (media group) with up to 10 items per call
// items: [{
//   type: 'photo'|'video',
//   buffer?: Buffer,            // attach from buffer
//   filePath?: string,          // or attach from local path
//   url?: string,               // or send by URL
//   filename?: string,
//   // optional video meta for better previews
//   duration?: number, width?: number, height?: number,
//   // optional thumbnail
//   thumbBuffer?: Buffer, thumbPath?: string, thumbUrl?: string
// }]
async function sendMediaGroup(chatId, items, captionHtml) {
  const url = `http://127.0.0.1:8081/bot${BOT_TOKEN}/sendMediaGroup`;
  const form = new FormData();
  form.append('chat_id', String(chatId));

  // Build media array; first item may carry caption
  const media = [];
  let attachIndex = 0;
  const filesToAttach = [];
  items.forEach((it, idx) => {
    const entry = { type: it.type === 'video' ? 'video' : 'photo' };
    if (it.buffer) {
      const name = `file${attachIndex++}`;
      entry.media = `attach://${name}`;
      filesToAttach.push({ name, buffer: it.buffer, filename: it.filename || (it.type === 'video' ? 'video.mp4' : 'photo.jpg'), contentType: it.type === 'video' ? 'video/mp4' : 'image/jpeg' });
    } else if (it.filePath) {
      const name = `file${attachIndex++}`;
      entry.media = `attach://${name}`;
      filesToAttach.push({ name, filePath: it.filePath, filename: it.filename || (it.type === 'video' ? 'video.mp4' : 'photo.jpg'), contentType: it.type === 'video' ? 'video/mp4' : 'image/jpeg' });
    } else if (it.url) {
      entry.media = it.url;
    }
    // Optional video meta for better previews
    if (it.type === 'video') {
      entry.supports_streaming = true;
      if (typeof it.duration === 'number' && it.duration > 0) entry.duration = Math.round(it.duration);
      if (typeof it.width === 'number' && it.width > 0) entry.width = Math.round(it.width);
      if (typeof it.height === 'number' && it.height > 0) entry.height = Math.round(it.height);
      if (it.thumbBuffer || it.thumbPath || it.thumbUrl) {
        if (it.thumbBuffer || it.thumbPath) {
          const tname = `thumb${attachIndex++}`;
          entry.thumbnail = `attach://${tname}`; // Bot API supports 'thumbnail'
          if (it.thumbBuffer) filesToAttach.push({ name: tname, buffer: it.thumbBuffer, filename: 'thumb.jpg', contentType: 'image/jpeg' });
          else if (it.thumbPath) filesToAttach.push({ name: tname, filePath: it.thumbPath, filename: 'thumb.jpg', contentType: 'image/jpeg' });
        } else if (it.thumbUrl) {
          entry.thumbnail = it.thumbUrl;
        }
      }
    }
    if (idx === 0 && captionHtml) { entry.caption = captionHtml; entry.parse_mode = 'HTML'; }
    media.push(entry);
  });

  form.append('media', JSON.stringify(media));
  for (const f of filesToAttach) {
    if (Buffer.isBuffer(f.buffer)) form.append(f.name, f.buffer, { filename: f.filename, contentType: f.contentType });
    else if (f.filePath) form.append(f.name, fs.createReadStream(f.filePath), { filename: f.filename, contentType: f.contentType });
  }

  const resp = await axios.post(url, form, { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity });
  if (!resp?.data?.ok) {
    const msg = (resp && resp.data && resp.data.description) ? resp.data.description : 'sendMediaGroup failed';
    const e = new Error(msg);
    e.response = resp?.data;
    throw e;
  }
  return resp;
}

async function sendPhotoByUrl(chatId, fileUrl, caption) {
  const url = `http://127.0.0.1:8081/bot${BOT_TOKEN}/sendPhoto`;
  const payload = { chat_id: chatId, photo: fileUrl };
  if (caption) payload.caption = caption;
  payload.parse_mode = 'HTML';
  payload.reply_markup = defaultReplyKeyboard();
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

async function editMessageWithMarkup(chatId, messageId, text, replyMarkup, parseMode = 'HTML') {
  const url = `http://127.0.0.1:8081/bot${BOT_TOKEN}/editMessageText`;
  return axios.post(url, { chat_id: chatId, message_id: messageId, text, parse_mode: parseMode, disable_web_page_preview: true, reply_markup: replyMarkup });
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
const NOISY_OFF = process.env.DL_HIDE_NOISY === '1' || process.env.DL_SILENT === '1';
const PROG_DEBUG = (process.env.BOT_PROGRESS_DEBUG === '1') && !NOISY_OFF;
const MAX_QUEUE_SIZE = 12; // 防止无限堆积

async function tryDeleteProgressMessage(chatId, fallbackId, attempts = 3) {
  // 组合可能的消息ID：当前跟踪ID + 初始ID（都尝试，不能因为其一失败就提前返回）
  const ids = new Set();
  try { const tracked = progressTracker.get(chatId); if (tracked) ids.add(tracked); } catch (_) {}
  if (fallbackId) ids.add(fallbackId);
  if (ids.size === 0) return;

  for (let i = 0; i < attempts; i++) {
    let anyResolved = false; // 成功删除或“已不存在”都视为已解决
    for (const id of Array.from(ids)) {
      try {
        const r = await deleteMessage(chatId, id);
        if (process.env.BOT_PROGRESS_DEBUG === '1') {
          try { console.log(`[DEL] chat ${chatId} msg ${id} -> ${(r && r.data && r.data.ok) ? 'ok' : 'resp'}`); } catch (_) {}
        }
        if (!r || (r.data && r.data.ok)) {
          ids.delete(id);
          anyResolved = true;
          continue;
        }
      } catch (e) {
        const desc = e?.response?.data?.description || '';
        if (typeof desc === 'string') {
          if (desc.includes('message to delete not found')) {
            // 该ID已不存在，视为已解决
            ids.delete(id);
            anyResolved = true;
            continue;
          }
          if (desc.includes("can't be deleted")) {
            // 该ID当前不可删，继续尝试其它ID，不要提前 return
            continue;
          }
        }
        // 其它错误，短暂退避后下一轮重试
        await new Promise(r => setTimeout(r, 300));
      }
    }
    if (ids.size === 0 || anyResolved) return;
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
        // 在原卡片内切换到邀请卡片
        const text = getInviteMessageText(chatId, cb.from?.id);
        try { await editMessageWithMarkup(chatId, messageId, text, inviteInlineKeyboard()); }
        catch (_) { await showInviteCard(chatId, cb.from?.id); }
      } else if (data === 'invite_withdraw') {
        await sendMessage(chatId, '收益提现：请联系管理员处理或稍后在面板中开通。');
      } else if (data === 'topup') {
        // 优先尝试在原卡片内“跳转”，失败则新发一条
        try { await editMessageWithMarkup(chatId, messageId, getTopupMessageText(), topupInlineKeyboard()); }
        catch (_) { await showTopupCard(chatId); }
      } else if (data === 'topup_svip') {
        // 这里可跳转支付页或进一步说明；先简单提示
        await sendMessage(chatId, '购买 SVIP：请联系管理员或访问官网开通。');
      } else if (data === 'topup_big') {
        await sendMessage(chatId, '充值大文件额度：请联系管理员或访问官网充值。');
      } else if (data === 'back_start') {
        try { await editMessageWithMarkup(chatId, messageId, getStartMessageText(), startInlineKeyboard()); }
        catch (_) { await sendMessage(chatId, getStartMessageText(), 'HTML', { replyMarkup: startInlineKeyboard() }); }
      } else if (data === 'me') {
        // 显示“我的”权限提示卡片
        try {
          const u = await userStore.getOrCreate(chatId);
          await editMessageWithMarkup(chatId, messageId, getMyMessageText(u), myInlineKeyboard());
        } catch (_) {
          await showMyCard(chatId);
        }
      }
      return;
    }
    const msg = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
    if (!msg || (!msg.text && !msg.caption)) return;
    const chatId = msg.chat?.id;
    const mid = msg.message_id;
    // Drop duplicates within TTL (e.g., message followed by edited_message)
    if (chatId && mid && _seenRecently(chatId, mid)) return;
    const text = msg.text || msg.caption || '';
    const trimmed = text.trim();
    // 确保用户出现在用户库：首次交互即入库，便于管理后台可见
    try { if (chatId) await userStore.ensureSaved(chatId); } catch (_) {}
    // Login state store (in-memory)
    if (!global._botLoginStates) global._botLoginStates = new Map();
    const loginState = global._botLoginStates;
    // Handle simple commands
    if (/^\/start\b/.test(trimmed) || /^\/menu\b/.test(trimmed)) {
      // First-time tip: show user's ID above the welcome card
      try {
        const key = String(chatId);
        if (!chatFlags[key] || !chatFlags[key].shownIdTip) {
          const uid = resolveUserIdFromStore(chatId) || (msg.from?.id ? String(msg.from.id) : String(chatId));
          await sendMessage(chatId, `您的ID： ${uid}`, 'HTML', { noReplyKeyboard: true });
          chatFlags[key] = { ...(chatFlags[key] || {}), shownIdTip: true };
          await saveChatFlags();
        }
      } catch (_) {}
      // Send the welcome message with inline keyboard
      await sendMessage(chatId, getStartMessageText(), 'HTML', { replyMarkup: startInlineKeyboard() });
      return;
    }
    // /recharge 指令：直接展示充值卡片
    if (/^\/recharge\b/.test(trimmed)) {
      await showTopupCard(chatId);
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
      await showInviteCard(chatId, msg.from?.id);
      return;
    }
    if (trimmed === BTN_TOPUP) {
      await showTopupCard(chatId);
      return;
    }
    if (trimmed === BTN_ME) {
      await showMyCard(chatId);
      return;
    }
    if (/^\/cancel\b/.test(trimmed)) {
      const t = activeTasks.get(chatId);
      if (t) { t.cancel = true; await sendMessage(chatId, '已发送取消请求，正在停止下载…'); }
      else { await sendMessage(chatId, '当前没有正在进行的下载任务。'); }
      return;
    }
    if (/^\/my\b/.test(trimmed)) {
      await showMyCard(chatId);
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
      // 直接发送的邀请链接（t.me/+CODE 或 t.me/joinchat/CODE）也做支持：直接回显标准化链接
      const inviteReList = [
        /https?:\/\/(?:t|telegram)\.me\/\+([A-Za-z0-9_-]+)/i,
        /https?:\/\/(?:t|telegram)\.me\/joinchat\/([A-Za-z0-9_-]+)/i,
        /tg:\/\/join\?invite=([A-Za-z0-9_-]+)/i,
      ];
      let inviteLink = null;
      for (const re of inviteReList) {
        const m = text.match(re);
        if (m && m[1]) { inviteLink = text.includes('joinchat') ? `https://t.me/joinchat/${m[1]}` : `https://t.me/+${m[1]}`; break; }
      }
      if (inviteLink) {
        // 不添加额外前缀，直接回传链接本身，允许网页预览
        await sendMessage(chatId, inviteLink, 'HTML', { preview: true });
        return;
      }
      if (chatId) await sendMessage(chatId, '请发送 Telegram 消息链接，例如 https://t.me/<用户名>/<消息ID> 或 https://t.me/c/<内部ID>/<消息ID>');
      return;
    }

    // 强制关注频道校验：仅在尝试下载（发送链接）时触发
    // 同时为首次发送链接的用户，在校验前先推送一次关注提示卡片（不拦截流程）
    try {
      const flags = getFlag(chatId);
      if (!flags.shownFollowTip) await maybeSendFollowTip(chatId, true);
    } catch (_) {}
    try {
      const fromId = msg.from?.id;
      const passed = await ensureSubscribed(chatId, fromId);
      if (!passed) return; // 未关注或无法验证 -> 已提示并退出
    } catch (_) {
      // 避免因为异常而继续下载；统一显示关注提示样式
      await maybeSendFollowTip(chatId);
      return;
    }

    const sessionId = await getWorkingSessionId(chatId);
    if (!sessionId) {
      if (chatId) await sendMessage(chatId, '后端尚未登录 Telegram 用户会话，无法读取频道消息');
      return;
    }

    // Warm up sandbox early to avoid cold-start latency (no-op if exists)
    try { if (chatId && sessionId) sandboxManager.ensureSandbox(chatId, sessionId); } catch (_) {}

    // Special case: if该消息是“邀请私密群组/频道”的链接卡片，只提取并返回加入链接
    try {
      const invite = await telegramService.extractInviteLinkFromMessageLink(sessionId, text).catch(() => null);
      if (invite && invite.link) {
        // 保留原消息中的说明文本，不添加额外前缀；若提取到的是 joinchat/+/tg 形式，替换为标准 https 链接
        let out = invite.text || invite.link;
        if (invite.raw && invite.link && invite.raw !== invite.link) {
          try { out = out.replace(invite.raw, invite.link); } catch (_) {}
        }
        await sendMessage(chatId, out, 'HTML', { preview: true });
        return; // 不进入下载流程、不扣额度
      }
    } catch (_) { /* ignore and continue to normal flow */ }

    // Special case: links like .../12345?single -> extract the whole album (all photos/videos) and the text
    if (/\?single(\b|$)/i.test(text)) {
      try {
        const album = await telegramService.getAlbumFromMessageLink(sessionId, text);
        if (album && Array.isArray(album.items) && album.items.length) {
          const totalCount = album.items.length;

          // Progress card — initialize
          let progressMsgId = null;
          try {
            const initCard = makeProgressTemplate({
              link: text,
              stage: 'download',
              index: 1,
              totalCount,
              fileName: '准备中…',
              received: 0,
              total: 0,
              percentOverride: 0,
            });
            const sent = await sendMessage(chatId, initCard, 'HTML', { noReplyKeyboard: true });
            progressMsgId = sent?.data?.result?.message_id || null;
            if (progressMsgId) progressTracker.set(chatId, progressMsgId);
          } catch (_) {}

          // Build media group parts and send in batches of 10
          // 统一走本地附件上传（attach://），并在下载阶段更新进度
          const tmpDir = path.join(process.cwd(), 'downloads', 'bot');
          fs.mkdirSync(tmpDir, { recursive: true });
          const parts = [];
          const cleanupPaths = [];

          // Helper to edit progress card safely
          const updateProgress = (idx, fileName, received, total, pctOverride = null, stage = 'download', speedText = '') => {
            if (!progressMsgId) return;
            let card = makeProgressTemplate({
              link: text,
              stage,
              index: Math.max(1, Math.min(totalCount, idx)),
              totalCount,
              fileName: fileName || '处理中…',
              received: received || 0,
              total: total || 0,
              speedText,
              percentOverride: typeof pctOverride === 'number' ? pctOverride : null,
            });
            try { card += (Date.now() % 2 === 0 ? '\u2063' : '\u2060'); } catch (_) {}
            const trackedId = getTrackedMessageId(chatId, progressMsgId);
            if (trackedId) queueEdit(chatId, trackedId, card).catch(() => {});
          };

          // Parse base link for thumbnails (reuse the same chat path, replace id later)
          const parsedBase = parseTelegramLink(text);
          const makeItemLink = (id) => {
            if (!parsedBase) return text.replace(/\d+(?:\?single.*)?$/, String(id));
            if (parsedBase.type === 'internal') return `https://t.me/c/${parsedBase.chat}/${id}`;
            return `https://t.me/${parsedBase.chat}/${id}`;
          };

          for (let idx = 0; idx < album.items.length; idx++) {
            const it = album.items[idx];
            try {
              if (it.kind === 'photo') {
                updateProgress(idx + 1, `photo_${it.id}.jpg`, 0, 0, (idx / totalCount) * 100);
                const buf = await telegramService.getMessagePhoto(sessionId, album.channelId, it.id);
                // Try thumbnail also for consistency (Telegram ignores for photos but safe)
                const thumb = buf; // reuse
                if (buf) parts.push({ type: 'photo', buffer: buf, filename: `photo_${it.id}.jpg`, thumbBuffer: thumb });
                updateProgress(idx + 1, `photo_${it.id}.jpg`, 1, 1, ((idx + 1) / totalCount) * 100);
              } else if (it.kind === 'video') {
                const target = path.join(tmpDir, `al_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
                let lastPct = 0; let lastTs = 0; let speedAvg = 0; let lastB = 0; let lastSpeedTs = Date.now();
                // Download with per-file progress and update overall percent
                const r = await telegramService.downloadMediaToPath(
                  sessionId,
                  album.channelId,
                  it.id,
                  target,
                  (received, total) => {
                    const now = Date.now();
                    const pct = total ? (received / total) * 100 : 0;
                    if (pct >= lastPct + 1 || now - lastTs > 1000) {
                      lastPct = pct; lastTs = now;
                      try {
                        const dt = now - lastSpeedTs;
                        if (dt >= 400) {
                          const diff = Math.max(0, received - lastB);
                          const inst = diff / (dt / 1000);
                          speedAvg = speedAvg ? (0.7 * speedAvg + 0.3 * inst) : inst;
                          lastSpeedTs = now; lastB = received;
                        }
                      } catch (_) {}
                      const etaPart = (idx + (total ? received / total : 0)) / totalCount;
                      const s = prettySpeed(speedAvg);
                      const upText = s ? `⚡ ${s}` : '';
                      updateProgress(idx + 1, path.basename(target), received, total, etaPart * 100, 'download', upText);
                    }
                  }
                );
                // Thumbnail for nicer previews
                let thumbBuffer = null;
                try { thumbBuffer = await telegramService.getThumbnailFromMessageLink(sessionId, makeItemLink(it.id), 'm'); } catch (_) {}
                parts.push({
                  type: 'video',
                  filePath: r.filePath,
                  filename: path.basename(r.filePath),
                  duration: r.duration,
                  width: r.width,
                  height: r.height,
                  thumbBuffer,
                });
                cleanupPaths.push(r.filePath);
                updateProgress(idx + 1, path.basename(r.filePath), r.size || 0, r.size || 0, ((idx + 1) / totalCount) * 100);
              }
            } catch (_) {}
          }

          // Send in groups of 10, carry caption on first request
          const chunks = [];
          for (let i = 0; i < parts.length; i += 10) chunks.push(parts.slice(i, i + 10));
          let caption = (album.caption || '').trim();
          const captionEsc = caption ? escapeHtml(caption).slice(0, 1024) : undefined;
          for (let i = 0; i < chunks.length; i++) {
            const cap = i === 0 ? captionEsc : undefined;
            // Update stage to upload between groups
            updateProgress(Math.min((i * 10) + 1, totalCount), '开始上传…', 0, 0, 100, 'send');
            try {
              await sendMediaGroup(chatId, chunks[i], cap);
            } catch (eSend) {
              // Fallback: send items sequentially when group fails
              for (let j = 0; j < chunks[i].length; j++) {
                const it = chunks[i][j];
                try {
                  if (it.type === 'photo') {
                    if (it.buffer) await sendPhoto(chatId, it.buffer, j === 0 ? cap : undefined);
                    else if (it.filePath) await sendPhoto(chatId, it.filePath, j === 0 ? cap : undefined);
                    else if (it.url) await sendPhotoByUrl(chatId, it.url, j === 0 ? cap : undefined);
                  } else if (it.type === 'video') {
                    if (it.filePath) await sendVideo(chatId, it.filePath, j === 0 ? cap : undefined, {});
                    else if (it.url) await sendVideoByUrl(chatId, it.url, j === 0 ? cap : undefined, {});
                  }
                } catch (_) {}
              }
            }
          }

          // Cleanup temporary files after Telegram fetches them
          try { cleanupPaths.forEach(p => scheduleDelete(p)); } catch (_) {}
          // Remove progress card
          try { if (progressMsgId) await deleteMessage(chatId, progressMsgId); } catch (_) {}
          try { progressTracker.delete(chatId); } catch (_) {}
          return;
        }
      } catch (e) {
        try { await sendMessage(chatId, `提取失败：${e?.message || '未知错误'}`); } catch (_) {}
        return;
      }
    }

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
        fileName: meta?.originalFileName || meta?.displayName,
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
                fileName: m.originalFileName || m.displayName,
                received: 0,
                total: m.size || 0,
              });
              try { card += (Date.now() % 2 === 0 ? '\u2063' : '\u2060'); } catch (_) {}
              const trackedForMeta = getTrackedMessageId(chatId, progressMsgId);
              if (trackedForMeta) queueEdit(chatId, trackedForMeta, card).catch(() => {});
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
    // 大文件额度：> BIGFILE_THRESHOLD 计一次
    let consumeBig = 0;
    if (!BOT_EAGER_START) {
      if (meta && meta.size && Number(meta.size) > BIGFILE_THRESHOLD) consumeBig = 1;
      if (consumeBig) {
        const credits = Number(user.bigFileCredits || 0);
        if (credits < 1) {
          await sendMessage(chatId, `你的大文件额度不足，无法下载超过 ${(BIGFILE_THRESHOLD/1024/1024).toFixed(0)}MB 的文件。请先充值大文件额度。`);
          // 归还今日额度
          try { await userStore.refundDaily(chatId); } catch (_) {}
          return;
        }
      }
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
    // 统一改为本进程后台处理，由 SandboxManager 负责同 chat 串行与全局并发
    setImmediate(() => {
      (async () => {
        try {
          await processQueuedTask(taskPayload);
        } catch (inlineErr) {
          try { await sendMessage(chatId, `下载失败：${inlineErr?.message || '未知错误'}`); } catch (_) {}
        }
      })();
    });
    return;
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

// Payment webhook for iDataRiver: POST /api/bot/payments/idatariver
// Accepts JSON; verifies optional shared secret; upgrades a user to SVIP on success
router.post('/payments/idatariver', async (req, res) => {
  try {
    // Secret verification (any one of the headers or query values)
    const expect = process.env.IDATARIVER_WEBHOOK_SECRET || process.env.PAYMENT_WEBHOOK_SECRET || '';
    if (expect) {
      const H = req.headers || {};
      const bearer = (H.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const secret = H['x-idatariver-secret'] || H['x-webhook-secret'] || bearer || req.query?.secret;
      if (secret !== expect) return res.status(401).json({ error: 'unauthorized' });
    }

    const body = req.body || {};
    // Try to determine payment status and user id from a variety of common fields
    const status = (body.status || body.event || body.state || '').toString().toLowerCase();
    const ok = ['success', 'paid', 'succeeded', 'completed'].some(s => status.includes(s)) || body.paid === true;
    const userId = body.telegram_id || body.tg_id || body.user_id || body.chat_id || body.telegramId || body.tgId || body.uid || body.customer_id || null;
    if (!ok) return res.json({ ok: true, ignored: true });
    if (!userId) return res.status(400).json({ error: 'missing user id' });

    // Upgrade to SVIP and persist
    await userStore.setPlan(userId, 'svip');
    try { await sendMessage(userId, '支付成功，已为你开通 SVIP。感谢支持！'); } catch (_) {}
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
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
          fileName: meta?.originalFileName || meta?.displayName || '获取文件名中…',
          received: 0,
          total: t,
          status: `${SPIN[spinIdx++ % SPIN.length]} 准备中…`
        });
        try { card += (Date.now() % 2 === 0 ? '\u2063' : '\u2060'); } catch (_) {}
        const trackedId = getTrackedMessageId(chatId, progressMsgId);
        if (trackedId) queueEdit(chatId, trackedId, card).catch(() => {});
      } catch (_) {}
    }, 900) : null;

    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      let stalledTriggered = false;
      const watchdog = setInterval(() => {
        try {
          if (Date.now() - lastTs > WATCHDOG_IDLE_MS) {
            stalledTriggered = true;
            if (PROG_DEBUG) console.log(`[EDIT] watchdog stall chat ${chatId}, destroying sandbox`);
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
            try { if (PROG_DEBUG) console.log(`[PROG] chat ${chatId} recv=${received} total=${total}`); } catch(_) {}
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
              fileName: meta?.originalFileName || meta?.displayName || '获取文件名中…',
              received: r,
              total: t,
              speedText,
              percentOverride,
            });
  // 为避免 Telegram 报 "message is not modified"，在文本末尾附加不可见字符作“心跳”
  try { textCard += (Date.now() % 2 === 0 ? '\u2063' : '\u2060'); } catch (_) {}
  const trackedId3 = getTrackedMessageId(chatId, progressMsgId);
  if (trackedId3) queueEdit(chatId, trackedId3, textCard).catch(() => {});
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

    // 发送阶段前校验：单文件上限 & 大文件额度（用于 EAGER 模式或 meta 不全的情况）
    try {
      const userNow = await userStore.getOrCreate(chatId);
      const sizeLimitNow = Number(userNow.maxFileBytes || 0) || 0;
      const fileSize = Number(result?.size || 0) || 0;
      if (sizeLimitNow && fileSize && fileSize > sizeLimitNow) {
        await sendMessage(chatId, `你的套餐单文件上限为 ${(sizeLimitNow/1024/1024).toFixed(0)}MB，此文件大小为 ${(fileSize/1024/1024).toFixed(0)}MB，已跳过。`);
        try { if (result?.filePath) fs.unlinkSync(result.filePath); } catch (_) {}
        activeTasks.delete(chatId);
        try { await userStore.refundDaily(chatId); } catch (_) {}
        return;
      }
      if (fileSize > BIGFILE_THRESHOLD) {
        const credits = Number(userNow.bigFileCredits || 0);
        if (credits <= 0) {
          await sendMessage(chatId, `你的大文件额度不足，无法下载超过 ${(BIGFILE_THRESHOLD/1024/1024).toFixed(0)}MB 的文件。请先充值大文件额度。`);
          try { if (result?.filePath) fs.unlinkSync(result.filePath); } catch (_) {}
          activeTasks.delete(chatId);
          try { await userStore.refundDaily(chatId); } catch (_) {}
          return;
        }
      }
    } catch (_) {}

    // 发送阶段：优先直传 multipart，失败回退 URL
    const publicBase = process.env.PUBLIC_BASE_URL || (process.env.BOT_WEBHOOK_URL ? new URL(process.env.BOT_WEBHOOK_URL).origin : '');
    const publicPath = `/bot/${path.basename(result.filePath)}`;
    const publicUrl = publicBase ? `${publicBase}${publicPath}` : publicPath;

    // 若在下载完成后才收到取消请求，则直接终止发送并清理
    try { const st = activeTasks.get(chatId); if (st && st.cancel) { try { await tryDeleteProgressMessage(chatId, progressMsgId, 3); } catch(_) {} ; activeTasks.delete(chatId); try { fs.unlinkSync(result.filePath); } catch(_) {}; try { await sendMessage(chatId, '已取消当前下载任务。'); } catch(_) {}; return; } } catch (_) {}

    let sendRes;
    let uploadedLocal = false;
    const mime = String(result?.mimeType || '').toLowerCase();
    const isImage = mime.startsWith('image/');
    const isVideo = mime.startsWith('video/');
    // 图片的说明规则：有原消息文本则保留，否则不使用占位名
    const rawCaption = (typeof result?.caption === 'string' && result.caption.trim()) ? result.caption.trim() : null;
    const captionText = isImage ? (rawCaption || undefined) : (result?.originalFileName || result?.displayName || result?.fileName || '');
    const capEscaped = captionText ? escapeHtml(captionText) : undefined;

    if (isImage) {
      // Photos: try local sendPhoto first, then URL fallback
      try {
        sendRes = await sendPhoto(
          chatId,
          result.filePath,
          capEscaped
        );
        uploadedLocal = true;
      } catch (_) {
        try {
          sendRes = await sendPhotoByUrl(chatId, publicUrl, capEscaped);
        } catch (e2) {
          // 无说明时也不附加占位名
          sendRes = await sendDocumentByUrl(chatId, publicUrl, capEscaped, path.basename(result.filePath));
        }
      }
    } else {
      // Default: treat as video/document with progress reporting
      try {
        let lastUpPct = 0; let lastUpTs = 0;
        let upSpeedAvgBps = 0; let lastUpBytesVal = 0; let lastUpSpeedTs = Date.now();
        let thumbBuffer = null;
        try { thumbBuffer = await telegramService.getThumbnailFromMessageLink(sessionId, text, 'm'); } catch (_) {}

        sendRes = await sendVideo(
          chatId,
          result.filePath,
          (result.originalFileName || result.displayName || result.fileName || '视频'),
          { duration: result.duration, width: result.width, height: result.height, size: result.size, thumbBuffer },
          (sentBytes, totalBytes) => {
            const now = Date.now();
            const pct = totalBytes ? (sentBytes / totalBytes) * 100 : 0;
            const isFinal = totalBytes && sentBytes >= totalBytes;
            if (isFinal || pct >= lastUpPct + 1 || now - lastUpTs > 1500) {
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
                  if (!isFinal && upSpeedAvgBps > 0) {
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
                  received: (totalBytes && sentBytes > totalBytes) || isFinal ? totalBytes : sentBytes,
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
          sendRes = await sendVideoByUrl(chatId, publicUrl, (result.originalFileName || result.displayName || result.fileName || '视频'), {
            duration: result.duration,
            width: result.width,
            height: result.height,
          });
        } catch (e2) {
          sendRes = await sendDocumentByUrl(chatId, publicUrl, (result.originalFileName || result.displayName || result.fileName || '视频'), path.basename(result.filePath));
        }
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
      // 再次延迟尝试清理，规避 Telegram 短暂的删除窗口/竞态
      try { setTimeout(() => { tryDeleteProgressMessage(chatId, progressMsgId, 2).catch(() => {}); }, 2500); } catch (_) {}
      try { setTimeout(() => { tryDeleteProgressMessage(chatId, progressMsgId, 2).catch(() => {}); }, 10000); } catch (_) {}
      try { progressTracker.delete(chatId); } catch (_) {}
    }
    if (!sendRes?.data?.ok) {
      try { await sendMessage(chatId, `发送失败：${sendRes?.data?.description || '未知错误'}`); } catch (_) {}
    }
    activeTasks.delete(chatId);
    // 扣减大文件额度（仅成功才扣）。若 webhook 阶段未拿到 meta，则根据实际文件大小判断。
    try {
      const bigByResult = (result && result.size && Number(result.size) > BIGFILE_THRESHOLD) ? 1 : 0;
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
