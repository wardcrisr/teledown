const express = require('express');
const router = express.Router();
const userStore = require('../services/userStore');
const progressStore = require('../services/progressStore');

const ADMIN_SECRET = process.env.ADMIN_SECRET || process.env.BOT_BIND_SECRET || '';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

function assertAdmin(req, res) {
  // Secret 校验
  if (ADMIN_SECRET) {
    const token = req.headers['x-admin-secret'] || req.query.secret;
    if (token !== ADMIN_SECRET) {
      res.status(401).json({ error: 'unauthorized' });
      return false;
    }
  }
  // 账号密码校验（配置了才启用）
  if (ADMIN_USER) {
    const u = req.headers['x-admin-user'];
    const p = req.headers['x-admin-pass'];
    if (u !== ADMIN_USER || p !== ADMIN_PASS) {
      res.status(401).json({ error: 'unauthorized' });
      return false;
    }
  }
  return true;
}

router.get('/users', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    // 可在查询参数中携带 seedIds=1,2,3 用来确保这些用户存在
    const seed = (req.query.seedIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (seed.length) await userStore.ensureUsers(seed);
    const list = await userStore.list();
    res.json({ users: list });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

router.post('/users/setPlan', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { userId, plan } = req.body || {};
    if (!userId || !plan) return res.status(400).json({ error: 'userId and plan required' });
    const u = await userStore.setPlan(userId, plan);
    res.json({ ok: true, user: u });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

router.post('/users/grantCredits', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { userId, amount } = req.body || {};
    if (!userId || typeof amount === 'undefined') return res.status(400).json({ error: 'userId and amount required' });
    const u = await userStore.grantCredits(userId, Number(amount || 0));
    res.json({ ok: true, user: u });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

router.post('/users/resetDaily', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const u = await userStore.resetDaily(userId);
    res.json({ ok: true, user: u });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

module.exports = router;

// ----- Progress APIs -----
router.get('/progress', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const chatId = req.query.chatId;
    if (chatId) return res.json({ progress: progressStore.get(chatId) });
    return res.json({ list: progressStore.list() });
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});

router.post('/progress/clear', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { chatId } = req.body || {};
    if (chatId) progressStore.remove(chatId); else for (const p of progressStore.list()) progressStore.remove(p.chatId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});


