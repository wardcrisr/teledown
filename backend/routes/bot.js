const express = require('express');
const router = express.Router();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const telegramService = require('../services/telegram');
const sessionStore = require('../services/sessionStore');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOT_SECRET = process.env.BOT_WEBHOOK_SECRET || '';
const BOT_SESSION_ID = process.env.BOT_SESSION_ID || '';

function assertBotConfigured(res) {
  if (!BOT_TOKEN) {
    res.status(500).json({ error: 'BOT_TOKEN not configured' });
    return false;
  }
  return true;
}

async function getWorkingSessionId() {
  if (BOT_SESSION_ID) return BOT_SESSION_ID;
  try {
    const authed = await sessionStore.getAuthenticatedSessions();
    if (authed && authed.length) return authed[0].sessionId;
  } catch (_) {}
  return null;
}

async function sendMessage(chatId, text) {
  const url = `http://127.0.0.1:8081/bot${BOT_TOKEN}/sendMessage`;
  return axios.post(url, { chat_id: chatId, text });
}

async function sendVideo(chatId, filePath, caption) {
  const url = `http://127.0.0.1:8081/bot${BOT_TOKEN}/sendVideo`;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('video', fs.createReadStream(filePath));
  form.append('supports_streaming', 'true');
  if (caption) form.append('caption', caption);
  return axios.post(url, form, { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity });
}

async function sendVideoByUrl(chatId, fileUrl, caption) {
  const url = `http://127.0.0.1:8081/bot${BOT_TOKEN}/sendVideo`;
  const payload = { chat_id: chatId, video: fileUrl, supports_streaming: true };
  if (caption) payload.caption = caption;
  // Let Telegram fetch the file from our HTTPS URL; avoids local upload limits
  return axios.post(url, payload);
}

async function sendDocumentByUrl(chatId, fileUrl, caption, filename) {
  const url = `http://127.0.0.1:8081/bot${BOT_TOKEN}/sendDocument`;
  const payload = { chat_id: chatId, document: fileUrl };
  if (caption) payload.caption = caption;
  if (filename) payload.caption = caption ? `${caption}\n${filename}` : filename;
  return axios.post(url, payload);
}

async function editMessage(chatId, messageId, text) {
  const url = `http://127.0.0.1:8081/bot${BOT_TOKEN}/editMessageText`;
  return axios.post(url, { chat_id: chatId, message_id: messageId, text });
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
    const msg = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
    if (!msg || (!msg.text && !msg.caption)) return;
    const chatId = msg.chat?.id;
    const text = msg.text || msg.caption || '';
    // Handle simple commands
    if (/^\/cancel\b/.test(text.trim())) {
      const t = activeTasks.get(chatId);
      if (t) { t.cancel = true; await sendMessage(chatId, '已发送取消请求，正在停止下载…'); }
      else { await sendMessage(chatId, '当前没有正在进行的下载任务。'); }
      return;
    }
    if (/^\/status\b/.test(text.trim())) {
      const t = activeTasks.get(chatId);
      if (t && t.total) {
        const pct = Math.floor((t.current / t.total) * 100);
        await sendMessage(chatId, `下载进度：${pct}% (${(t.current/1048576).toFixed(1)}/${(t.total/1048576).toFixed(1)} MB)`);
      } else {
        await sendMessage(chatId, '暂无进行中的下载任务。');
      }
      return;
    }
    const parsed = parseTelegramLink(text);
    if (!parsed) {
      if (chatId) await sendMessage(chatId, '请发送 Telegram 消息链接，例如 https://t.me/<用户名>/<消息ID> 或 https://t.me/c/<内部ID>/<消息ID>');
      return;
    }

    const sessionId = await getWorkingSessionId();
    if (!sessionId) {
      if (chatId) await sendMessage(chatId, '后端尚未登录 Telegram 用户会话，无法读取频道消息');
      return;
    }

    let progressMsgId = null;
    if (chatId) {
      const sent = await sendMessage(chatId, '已收到链接，正在下载视频...\n下载中 0%');
      progressMsgId = sent?.data?.result?.message_id || null;
    }

    const tmpDir = path.join(process.cwd(), 'downloads', 'bot');
    fs.mkdirSync(tmpDir, { recursive: true });
    // 临时名仅作占位，实际下载函数会用消息中的原始文件名覆盖为 .mp4 等正确后缀
    const tmpName = `dl_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`;
    const target = path.join(tmpDir, tmpName);

    // Register active task
    const task = { cancel: false, current: 0, total: 0, startedAt: Date.now(), link: text };
    activeTasks.set(chatId, task);

    // Download via Telegram user session (GramJS) by message link
    let lastPct = 0;
    let lastTs = 0;
    const result = await telegramService.downloadFromMessageLinkToPath(sessionId, text, target, (received, total) => {
      task.current = received; task.total = total;
      if (task.cancel) return false; // abort
      if (!total || total <= 0) return true;
      const pct = Math.floor((received / total) * 100);
      const now = Date.now();
      if (pct >= lastPct + 5 || now - lastTs > 2000) {
        lastPct = pct; lastTs = now;
        const recMB = (received / (1024 * 1024)).toFixed(1);
        const totMB = (total / (1024 * 1024)).toFixed(1);
        console.log(`[BOT] chat ${chatId} downloading ${pct}% (${recMB}/${totMB} MB)`);
        if (progressMsgId) {
          editMessage(chatId, progressMsgId, `下载中 ${pct}% (已接收 ${recMB}MB / 共 ${totMB}MB)`)
            .catch(() => {});
        }
      }
      return true;
    });

    if (progressMsgId) {
      try { await editMessage(chatId, progressMsgId, '下载完成，准备发送...'); } catch (_) {}
    }

    // 发送阶段：优先直传 multipart，失败再回退到 URL（由本地 Bot API 拉取并发送）
    const publicBase = process.env.PUBLIC_BASE_URL || (process.env.BOT_WEBHOOK_URL ? new URL(process.env.BOT_WEBHOOK_URL).origin : '');
    const publicPath = `/bot/${path.basename(result.filePath)}`;
    const publicUrl = publicBase ? `${publicBase}${publicPath}` : publicPath;

    let sendRes;
    let uploadedLocal = false;
    try {
      // 优先直传（本地 Bot API 支持大文件上传）
      sendRes = await sendVideo(chatId, result.filePath, result.fileName || '视频');
      uploadedLocal = true;
    } catch (e) {
      // 任意错误（包括 413/400）都回退到 URL 方式
      try {
        sendRes = await sendVideoByUrl(chatId, publicUrl, result.fileName || '视频');
      } catch (e2) {
        // 最终兜底：以 document URL 方式发送
        sendRes = await sendDocumentByUrl(chatId, publicUrl, result.fileName || '视频', path.basename(result.filePath));
      }
    }

    // 直传成功才删除本地文件；URL 方式需保留以供拉取
    if (sendRes?.data?.ok && uploadedLocal) {
      try { fs.unlinkSync(result.filePath); } catch (_) {}
    }
    if (progressMsgId) {
      try { await editMessage(chatId, progressMsgId, '发送完成 ✅'); } catch (_) {}
    }
    activeTasks.delete(chatId);
    return sendRes.data;
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
