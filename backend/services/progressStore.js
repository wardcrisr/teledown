// In-memory progress store per chat
// chatId -> { stage, fileName, link, received, total, updatedAt }

class ProgressStore {
  constructor() {
    this.map = new Map();
  }

  update(chatId, payload) {
    const now = Date.now();
    const prev = this.map.get(chatId) || {};
    const next = { ...prev, ...payload, updatedAt: now };
    this.map.set(chatId, next);
  }

  get(chatId) {
    return this.map.get(chatId) || null;
  }

  remove(chatId) {
    this.map.delete(chatId);
  }

  list() {
    const out = [];
    for (const [chatId, v] of this.map.entries()) {
      out.push({ chatId, ...v });
    }
    return out;
  }
}

module.exports = new ProgressStore();


