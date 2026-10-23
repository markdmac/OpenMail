'use strict';
// Node side of the Outlook COM bridge. Spawns outlook-worker.ps1 and exchanges JSON lines with it.

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { EventEmitter } = require('events');

const WORKER = path.join(__dirname, 'outlook-worker.ps1');

class OutlookBridge extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = null;
    this.initArgs = null;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc = proc;
      let started = false;
      const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        let msg;
        try {
          msg = JSON.parse(line.replace(/^﻿/, ''));
        } catch {
          this.emit('log', `outlook-worker: ${line}`);
          return;
        }
        if (msg.id === 0 && !started) {
          started = true;
          resolve();
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(`Outlook: ${msg.error}`));
      });
      proc.stderr.on('data', (d) => this.emit('log', `outlook-worker stderr: ${d}`));
      proc.on('error', (err) => {
        if (!started) reject(err);
      });
      proc.on('exit', (code) => {
        this.emit('log', `outlook-worker exited (${code})`);
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('Outlook worker exited'));
        }
        this.pending.clear();
        this.proc = null;
        this.ready = null;
        if (!started) reject(new Error(`Outlook worker failed to start (exit ${code})`));
      });
    });
    return this.ready;
  }

  async call(cmd, args = {}, timeoutMs = 120000) {
    const wasRunning = !!this.ready;
    await this.start();
    // After a worker restart, reopen the PST before running anything else.
    if (!wasRunning && this.initArgs && cmd !== 'init') await this.raw('init', this.initArgs, timeoutMs);
    return this.raw(cmd, args, timeoutMs);
  }

  raw(cmd, args, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Outlook command "${cmd}" timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
    });
  }

  async init(pstPath, displayName) {
    this.initArgs = { pstPath, displayName };
    await this.start();
    return this.raw('init', this.initArgs, 180000);
  }

  stop() {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill();
    }
  }
}

module.exports = { OutlookBridge };
