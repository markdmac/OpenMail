'use strict';
// Independent minimal CFB reader used only by tests to read back what cfb-writer produced.

function readCfb(buf) {
  const sig = buf.subarray(0, 8).toString('hex');
  if (sig !== 'd0cf11e0a1b11ae1') throw new Error('bad signature');
  const sectorSize = 1 << buf.readUInt16LE(30);
  const miniSize = 1 << buf.readUInt16LE(32);
  const numFat = buf.readUInt32LE(44);
  const dirStart = buf.readUInt32LE(48);
  const cutoff = buf.readUInt32LE(56);
  const miniFatStart = buf.readUInt32LE(60);
  let difatSector = buf.readUInt32LE(68);
  const sector = (n) => buf.subarray(512 + n * sectorSize, 512 + (n + 1) * sectorSize);

  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < numFat; i++) fatSectors.push(buf.readUInt32LE(76 + i * 4));
  while (fatSectors.length < numFat) {
    const s = sector(difatSector);
    for (let i = 0; i < 127 && fatSectors.length < numFat; i++) fatSectors.push(s.readUInt32LE(i * 4));
    difatSector = s.readUInt32LE(508);
  }
  const fat = [];
  for (const fs of fatSectors) {
    const s = sector(fs);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(s.readUInt32LE(i * 4));
  }
  const chain = (start) => {
    const out = [];
    const seen = new Set();
    for (let s = start; s !== 0xfffffffe && s !== 0xffffffff; s = fat[s]) {
      if (seen.has(s)) throw new Error('FAT loop');
      seen.add(s);
      out.push(sector(s));
    }
    return Buffer.concat(out);
  };

  const dirBuf = chain(dirStart);
  const entries = [];
  for (let off = 0; off < dirBuf.length; off += 128) {
    const nameLen = dirBuf.readUInt16LE(off + 64);
    entries.push({
      name: dirBuf.toString('utf16le', off, off + Math.max(0, nameLen - 2)),
      type: dirBuf[off + 66],
      color: dirBuf[off + 67],
      left: dirBuf.readUInt32LE(off + 68),
      right: dirBuf.readUInt32LE(off + 72),
      child: dirBuf.readUInt32LE(off + 76),
      start: dirBuf.readUInt32LE(off + 116),
      size: dirBuf.readUInt32LE(off + 120),
    });
  }
  const root = entries[0];
  const miniStream = chain(root.start).subarray(0, root.size);
  const miniFat = [];
  if (miniFatStart !== 0xfffffffe) {
    const mf = chain(miniFatStart);
    for (let i = 0; i < mf.length / 4; i++) miniFat.push(mf.readUInt32LE(i * 4));
  }
  const readStream = (e) => {
    if (e.size === 0) return Buffer.alloc(0);
    if (e.size < cutoff) {
      const out = [];
      for (let s = e.start; s !== 0xfffffffe; s = miniFat[s]) out.push(miniStream.subarray(s * miniSize, (s + 1) * miniSize));
      return Buffer.concat(out).subarray(0, e.size);
    }
    return chain(e.start).subarray(0, e.size);
  };

  // Walk the sibling trees into a nested { name: Buffer | {...} } object.
  const siblings = (id, out = []) => {
    if (id === 0xffffffff) return out;
    const e = entries[id];
    siblings(e.left, out);
    out.push(e);
    siblings(e.right, out);
    return out;
  };
  const build = (e) => {
    const obj = {};
    for (const c of siblings(e.child)) obj[c.name] = c.type === 2 ? readStream(c) : build(c);
    return obj;
  };
  return { tree: build(root), entries };
}

module.exports = { readCfb };
