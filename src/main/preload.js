'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

contextBridge.exposeInMainWorld('openmail', {
  call,
  on(channel, cb) {
    const allowed = ['sync:status', 'log', 'import:progress'];
    if (!allowed.includes(channel)) throw new Error(`Unknown event ${channel}`);
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
