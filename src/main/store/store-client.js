'use strict';
// Main-process side of the mailbox worker: promise-based calls plus progress events.

const path = require('path');
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');

class StoreClient extends EventEmitter {
  constructor() {
    super();
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.openArgs = null;
  }

  start() {
    if (this.worker) return;
    // In a packaged build the mailbox engine is unpacked next to app.asar (worker threads can't load from it).
    this.worker = new Worker(path.join(__dirname, 'store-worker.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`));
    this.worker.on('message', (msg) => {
      if (msg.event) {
        this.emit(msg.event, msg.data);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else {
        const err = new Error(msg.error);
        err.workerStack = msg.stack;
        p.reject(err);
      }
    });
    this.worker.on('error', (e) => this.emit('log', `Mailbox worker error: ${e.stack || e.message}`));
    this.worker.on('exit', (code) => {
      this.emit('log', `Mailbox worker exited (${code})`);
      for (const p of this.pending.values()) p.reject(new Error('Mailbox worker stopped'));
      this.pending.clear();
      this.worker = null;
      this.opened = null;
    });
  }

  call(cmd, args = {}) {
    this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, cmd, args });
    });
  }

  /** Opens (or creates) the mailbox PST; repeated calls with the same path reuse the open file. */
  open(pstPath, displayName) {
    if (this.opened && this.openArgs?.pstPath === pstPath) return this.opened;
    this.openArgs = { pstPath, displayName };
    this.opened = this.call('open', this.openArgs).catch((e) => {
      this.opened = null;
      throw e;
    });
    return this.opened;
  }

  async stop() {
    if (!this.worker) return;
    try {
      await this.call('close');
    } catch {
      /* ignore */
    }
    await this.worker.terminate();
  }
}

module.exports = { StoreClient };
