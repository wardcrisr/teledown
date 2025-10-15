const { fork } = require('child_process');
const path = require('path');

function SBXDBG(...args) {
  try {
    if (process.env.DL_HIDE_NOISY === '1' || process.env.DL_HIDE_SBX === '1') return;
    if (process.env.DL_DEBUG === '1') console.log('[SBX]', ...args);
  } catch (_) {}
}

const GLOBAL_MAX_ACTIVE = parseInt(process.env.SANDBOX_MAX_ACTIVE || '2', 10);
const PROG_DEBUG = (process.env.BOT_PROGRESS_DEBUG === '1') && (process.env.DL_HIDE_NOISY !== '1') && (process.env.DL_HIDE_SBX !== '1');
// 每个 chatId 一个独立 sandbox，允许不同 chatId 并行；同一 chatId 串行
const SANDBOX_TTL_MS = parseInt(process.env.SANDBOX_TTL_MIN || '10', 10) * 60 * 1000; // default 10 minutes
const ALWAYS_ON = process.env.SANDBOX_ALWAYS_ON === '1';

class SandboxManager {
constructor() {
this.sandboxes = new Map(); // chatId -> { proc, sessionId, queue, running, timer, lastActiveAt, pending }
this.activeCount = 0;
}

ensureSandbox(chatId, sessionId) {
let sb = this.sandboxes.get(String(chatId));
if (sb && sb.sessionId === sessionId && sb.proc && !sb.proc.killed) {
sb.lastActiveAt = Date.now();
SBXDBG('reuse sandbox', { chatId, sessionId, active: this.activeCount });
return sb;
}
if (sb && sb.proc && !sb.proc.killed) {
try { sb.proc.kill(); } catch (_) {}
}
const workerPath = path.join(__dirname, 'worker.js');
const proc = fork(workerPath, [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
sb = { proc, sessionId, queue: [], running: false, timer: null, lastActiveAt: Date.now(), pending: null };
this.sandboxes.set(String(chatId), sb);
SBXDBG('create sandbox', { chatId, sessionId, active: this.activeCount });

proc.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'heartbeat') {
    sb.lastActiveAt = Date.now();
  } else if (msg.type === 'warm_ok') {
    if (PROG_DEBUG) { try { console.log(`[SBX] chat ${chatId} warm ok`); } catch(_) {} }
    SBXDBG('warm ok', { chatId });
  } else if (msg.type === 'progress') {
    if (PROG_DEBUG) {
      try { console.log(`[SBX] chat ${chatId} progress ${msg.received||0}/${msg.total||0}`); } catch(_) {}
    }
    const p = sb.pending; if (p && p.onProgress) { try { p.onProgress(msg.received||0, msg.total||0);} catch(_){} }
  } else if (msg.type === 'done') {
    const p = sb.pending; sb.pending = null; this.activeCount = Math.max(0, this.activeCount - 1);
    SBXDBG('job done', { chatId, sessionId, active: this.activeCount });
    if (p && p.resolve) p.resolve(msg.result);
    sb.running = false; this._maybeStart(chatId);
  } else if (msg.type === 'error') {
    const p = sb.pending; sb.pending = null; this.activeCount = Math.max(0, this.activeCount - 1);
    SBXDBG('job error', { chatId, sessionId, active: this.activeCount, error: msg.error });
    if (p && p.reject) p.reject(new Error(msg.error || 'sandbox error'));
    sb.running = false; this._maybeStart(chatId);
  }
});

proc.on('exit', () => {
  // If worker exits unexpectedly while a job is pending, fail the promise
  try {
    const cur = this.sandboxes.get(String(chatId));
    if (cur) {
      const p = cur.pending;
      if (p && p.reject) {
        this.activeCount = Math.max(0, this.activeCount - 1);
        try { p.reject(new Error('sandbox exited')); } catch (_) {}
        cur.pending = null;
        cur.running = false;
      }
    }
  } catch (_) {}
  this.sandboxes.delete(String(chatId));
  SBXDBG('sandbox exit', { chatId, sessionId });
});
proc.send({ type: 'init', sessionId });
// 主动 warm 一下：这会触发 Telegram 侧建立连接与载入对话列表，减少首包延迟
try { proc.send({ type: 'warm' }); } catch (_) {}
this._armTtl(chatId);
return sb;
}

async enqueueDownload(chatId, sessionId, link, onProgress) {
const sb = this.ensureSandbox(chatId, sessionId);
return new Promise((resolve, reject) => {
sb.queue.push({ type: 'download', link, onProgress, resolve, reject });
sb.lastActiveAt = Date.now();
SBXDBG('enqueue', { chatId, sessionId, queueLen: sb.queue.length, running: sb.running, active: this.activeCount });
this._maybeStart(chatId);
});
}

destroySandbox(chatId) {
const sb = this.sandboxes.get(String(chatId));
if (!sb) return;
// If there is a pending job, proactively fail it to unblock callers
try {
  if (sb.pending && sb.pending.reject) {
    this.activeCount = Math.max(0, this.activeCount - 1);
    try { sb.pending.reject(new Error('sandbox destroyed')); } catch (_) {}
    sb.pending = null;
    sb.running = false;
  }
} catch (_) {}
try { if (sb.proc && !sb.proc.killed) sb.proc.kill(); } catch (_) {}
if (sb.timer) { try { clearTimeout(sb.timer); } catch (_) {} }
this.sandboxes.delete(String(chatId));
}

_maybeStart(chatId) {
const sb = this.sandboxes.get(String(chatId));
if (!sb) return;
// If running flag is set but no pending job or worker dead, reset and continue
if (sb.running) {
  const procDead = (!sb.proc) || sb.proc.killed || (typeof sb.proc.exitCode === 'number') || (sb.proc.connected === false);
  const pendingMissing = !sb.pending;
  if (procDead || pendingMissing) {
    SBXDBG('stale running reset', { chatId, sessionId: sb.sessionId, procDead, pendingMissing, queueLen: sb.queue.length, active: this.activeCount });
    sb.running = false; sb.pending = null;
    if (procDead) {
      // Recreate worker process to guarantee a live IPC channel
      this.ensureSandbox(chatId, sb.sessionId);
      sb = this.sandboxes.get(String(chatId));
      SBXDBG('recreate sandbox', { chatId, sessionId: sb && sb.sessionId });
    }
  }
}
SBXDBG('maybe', { chatId, sessionId: sb.sessionId, running: sb.running, queueLen: sb.queue.length, active: this.activeCount });
if (sb.running) return;
if (!sb.queue.length) return;
if (this.activeCount >= GLOBAL_MAX_ACTIVE) { SBXDBG('throttle', { active: this.activeCount, max: GLOBAL_MAX_ACTIVE }); return; }

const job = sb.queue.shift();
sb.running = true; this.activeCount++; sb.pending = job; sb.lastActiveAt = Date.now();
SBXDBG('job start', { chatId, sessionId: sb.sessionId, active: this.activeCount });
sb.proc.send({ type: job.type, link: job.link });
}

_armTtl(chatId) {
const sb = this.sandboxes.get(String(chatId)); if (!sb) return;
if (ALWAYS_ON) return; // 永久常驻
if (sb.timer) { clearTimeout(sb.timer); sb.timer = null; }
sb.timer = setTimeout(() => {
const now = Date.now();
if (!sb.running && (!sb.queue.length) && now - sb.lastActiveAt >= SANDBOX_TTL_MS) {
this.destroySandbox(chatId);
} else {
this._armTtl(chatId);
}
}, SANDBOX_TTL_MS).unref?.();
}
}

module.exports = new SandboxManager();
