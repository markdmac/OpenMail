'use strict';
// Copies the mailbox PST to a backup folder (typically one synced by Google Drive, OneDrive or Dropbox).
// Runs only at shutdown, after the PST has been closed.

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Backup file names look like "<mailbox name> backup 2026-10-23 181500.pst". */
function backupPattern(srcPath) {
  const base = path.basename(srcPath, path.extname(srcPath)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${base} backup \\d{4}-\\d{2}-\\d{2} \\d{6}\\.pst$`, 'i');
}

/**
 * @param {string} srcPath mailbox PST (must be closed)
 * @param {string} destDir backup folder
 * @param {{keep?: number, onProgress?: (p:{copied:number,total:number})=>void, signal?: AbortSignal}} [opts]
 * @returns {Promise<{path:string, bytes:number, ms:number, removed:string[]}>}
 */
async function backupPst(srcPath, destDir, opts = {}) {
  if (!destDir) throw new Error('No backup folder is set. Choose one in Settings → Backup.');
  if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
    throw new Error(`The backup folder "${destDir}" was not found. Is your cloud drive connected?`);
  }
  if (!fs.existsSync(srcPath)) throw new Error(`Mailbox file not found: ${srcPath}`);
  if (path.resolve(path.dirname(srcPath)).toLowerCase() === path.resolve(destDir).toLowerCase()) {
    throw new Error('The backup folder must be different from the folder the mailbox is in.');
  }

  const started = Date.now();
  const total = fs.statSync(srcPath).size;
  const name = `${path.basename(srcPath, path.extname(srcPath))} backup ${stamp()}.pst`;
  const finalPath = path.join(destDir, name);
  const partial = `${finalPath}.partial`;
  let copied = 0;
  let lastReport = 0;
  const progress = new Transform({
    transform(chunk, _enc, cb) {
      copied += chunk.length;
      const now = Date.now();
      if (opts.onProgress && (now - lastReport > 200 || copied === total)) {
        lastReport = now;
        opts.onProgress({ copied, total });
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(fs.createReadStream(srcPath, { highWaterMark: 4 * 1024 * 1024 }), progress, fs.createWriteStream(partial), { signal: opts.signal });
    const written = fs.statSync(partial).size;
    if (written !== total) throw new Error(`Backup is incomplete (${written} of ${total} bytes)`);
    fs.renameSync(partial, finalPath);
  } catch (e) {
    fs.rmSync(partial, { force: true });
    if (e.name === 'AbortError') throw Object.assign(new Error('Backup cancelled'), { cancelled: true });
    throw e;
  }
  if (opts.onProgress) opts.onProgress({ copied: total, total });

  // Keep only the newest `keep` backups of this mailbox (names sort by date).
  const keep = Math.max(1, Number(opts.keep) || 3);
  const pattern = backupPattern(srcPath);
  const backups = fs.readdirSync(destDir).filter((f) => pattern.test(f)).sort().reverse();
  const removed = [];
  for (const old of backups.slice(keep)) {
    try {
      fs.rmSync(path.join(destDir, old));
      removed.push(old);
    } catch {
      /* a cloud client may hold the file briefly; try again next time */
    }
  }
  return { path: finalPath, bytes: total, ms: Date.now() - started, removed };
}

module.exports = { backupPst, backupPattern };
