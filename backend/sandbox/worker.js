const path = require('path');
const fs = require('fs');
const telegramService = require('../services/telegram');

let sessionId = null;
let cumulativeReceived = 0;
let fsWatchTimer = null;

function heartbeat() {
try { process.send && process.send({ type: 'heartbeat' }); } catch (_) {}
}
setInterval(heartbeat, 5000).unref?.();

process.on('message', async (msg) => {
try {
if (!msg || typeof msg !== 'object') return;
if (msg.type === 'init') {
sessionId = msg.sessionId;
try { await telegramService.restoreSession(sessionId); } catch (_) {}
return;
}
    if (msg.type === 'download') {
if (!sessionId) throw new Error('sandbox not initialized');
const link = msg.link;
const dir = path.join(process.cwd(), 'downloads', 'sbx');
fs.mkdirSync(dir, { recursive: true });
const target = path.join(dir, `dl_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`);
      cumulativeReceived = 0;
      // Start a 1s directory-size watcher (fallback). Note: telegramService chooses a safe
      // final file name inside the same directory, not necessarily `target`. We therefore
      // scan the directory and pick the most recently modified file as the candidate and
      // report its size as cumulative progress.
      try { if (fsWatchTimer) { clearInterval(fsWatchTimer); fsWatchTimer = null; } } catch (_) {}
      fsWatchTimer = setInterval(() => {
        try {
          const files = fs.readdirSync(dir).map(name => {
            try { const s = fs.statSync(path.join(dir, name)); return { name, mtime: s.mtimeMs, size: s.size }; } catch (_) { return null; }
          }).filter(Boolean);
          if (files.length) {
            files.sort((a, b) => b.mtime - a.mtime);
            const latest = files[0];
            if (latest && typeof latest.size === 'number') {
              cumulativeReceived = Math.max(cumulativeReceived, latest.size);
              process.send && process.send({ type: 'progress', received: cumulativeReceived, total: 0 });
            }
          }
        } catch (_) {}
      }, 1000);
      const result = await telegramService.downloadFromMessageLinkToPath(sessionId, link, target, (received, total) => {
        try { if (process.env.BOT_PROGRESS_DEBUG === '1') console.log(`[SBX] callback received=${received} total=${total}`); } catch (_) {}
        // Normalize different GramJS progress callback variants
        let r = Number(received || 0);
        const t = Number(total || 0);
        if (r > 0 && r <= 1 && (!t || t <= 1)) {
          // ratio in [0,1] → pass through; bot 会用 meta.size 估算
          try { process.send && process.send({ type: 'progress', received: r, total: 0 }); } catch (_) {}
        } else if (t && r <= t) {
          // cumulative bytes
          cumulativeReceived = r;
          try { process.send && process.send({ type: 'progress', received: cumulativeReceived, total: t }); } catch (_) {}
        } else {
          // chunk bytes without total → accumulate
          cumulativeReceived += r;
          try { process.send && process.send({ type: 'progress', received: cumulativeReceived, total: t }); } catch (_) {}
        }
        return true;
      });
      // ensure final 100% snapshot
      try {
        const fin = fs.statSync(target);
        if (fin && typeof fin.size === 'number' && fin.size >= cumulativeReceived) {
          cumulativeReceived = fin.size;
          try { process.send && process.send({ type: 'progress', received: cumulativeReceived, total: cumulativeReceived }); } catch (_) {}
        }
      } catch (_) {}
      try { if (fsWatchTimer) { clearInterval(fsWatchTimer); fsWatchTimer = null; } } catch (_) {}
      process.send && process.send({ type: 'done', result });
}
} catch (e) {
    try { if (fsWatchTimer) { clearInterval(fsWatchTimer); fsWatchTimer = null; } } catch (_) {}
process.send && process.send({ type: 'error', error: e && e.message || String(e) });
}
});