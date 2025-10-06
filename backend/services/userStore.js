const fs = require('fs');
const fsExtra = require('fs-extra');
const path = require('path');

const USERS_PATH = path.join(process.cwd(), 'sessions', 'users.json');
const DAY_MS = 24 * 60 * 60 * 1000;

const PLAN_DEFAULTS = {
  free: { dailyLimit: 1, bigFileCredits: 0, maxFileBytes: Infinity, allowPrivate: false },
  vip: { dailyLimit: 30, bigFileCredits: 1000, maxFileBytes: 200 * 1024 * 1024, allowPrivate: false },
  svip: { dailyLimit: 100, bigFileCredits: 5000, maxFileBytes: 4 * 1024 * 1024 * 1024, allowPrivate: true },
};

function nowDayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

class UserStore {
  constructor() {
    this.users = {};
    try { this.users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); } catch (_) { this.users = {}; }
  }

  async _save() {
    try {
      await fsExtra.ensureDir(path.dirname(USERS_PATH));
      await fsExtra.writeJson(USERS_PATH, this.users, { spaces: 2 });
    } catch (_) {}
  }

  _applyDailyReset(u) {
    const start = nowDayStart();
    if (!u.dailyResetAt || u.dailyResetAt < start) {
      u.dailyUsed = 0;
      u.dailyResetAt = start;
    }
  }

  _ensure(userId) {
    const key = String(userId);
    let u = this.users[key];
    if (!u) {
      const d = PLAN_DEFAULTS.free;
      u = this.users[key] = {
        userId: key,
        plan: 'free',
        dailyLimit: d.dailyLimit,
        dailyUsed: 0,
        dailyResetAt: nowDayStart(),
        bigFileCredits: d.bigFileCredits,
        maxFileBytes: d.maxFileBytes,
        allowPrivate: d.allowPrivate,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }
    this._applyDailyReset(u);
    return u;
  }

  async getOrCreate(userId) {
    const u = this._ensure(userId);
    return u;
  }

  async setPlan(userId, plan) {
    const u = this._ensure(userId);
    const d = PLAN_DEFAULTS[plan] || PLAN_DEFAULTS.free;
    u.plan = plan;
    u.dailyLimit = d.dailyLimit;
    u.maxFileBytes = d.maxFileBytes;
    u.allowPrivate = d.allowPrivate;
    if (u.bigFileCredits == null || u.bigFileCredits < d.bigFileCredits) {
      u.bigFileCredits = d.bigFileCredits;
    }
    u.updatedAt = Date.now();
    await this._save();
    return u;
  }

  async grantCredits(userId, amount) {
    const u = this._ensure(userId);
    u.bigFileCredits = Math.max(0, (u.bigFileCredits || 0) + Number(amount || 0));
    u.updatedAt = Date.now();
    await this._save();
    return u;
  }

  async resetDaily(userId) {
    const u = this._ensure(userId);
    u.dailyUsed = 0;
    u.dailyResetAt = nowDayStart();
    u.updatedAt = Date.now();
    await this._save();
    return u;
  }

  // Reserve a daily quota unit; returns true if ok
  async reserveDaily(userId) {
    const u = this._ensure(userId);
    if (u.dailyUsed >= u.dailyLimit) return false;
    u.dailyUsed += 1;
    u.updatedAt = Date.now();
    await this._save();
    return true;
  }

  async refundDaily(userId) {
    const u = this._ensure(userId);
    if (u.dailyUsed > 0) u.dailyUsed -= 1;
    u.updatedAt = Date.now();
    await this._save();
  }

  async consumeBigFileCredit(userId, count = 1) {
    const u = this._ensure(userId);
    if ((u.bigFileCredits || 0) < count) return false;
    u.bigFileCredits -= count;
    u.updatedAt = Date.now();
    await this._save();
    return true;
  }

  async list() {
    const arr = Object.values(this.users).map(u => ({ ...u }));
    return arr;
  }

  async ensureUsers(userIds = []) {
    let changed = false;
    for (const id of userIds) {
      const before = this.users[String(id)];
      if (!before) { this._ensure(String(id)); changed = true; }
    }
    if (changed) await this._save();
  }
}

module.exports = new UserStore();


