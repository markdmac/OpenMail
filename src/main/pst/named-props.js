'use strict';
// [MS-PST] 2.4.7 Named Property Lookup Map (NID_NAME_TO_ID_MAP): maps (GUID, name|id) ↔ property ids 0x8000+.

const { crc32 } = require('./crc');

const PS_MAPI = '00020328-0000-0000-c000-000000000046';
const PS_PUBLIC_STRINGS = '00020329-0000-0000-c000-000000000046';

function guidToBuf(g) {
  const h = g.replace(/-/g, '');
  const b = Buffer.from(h, 'hex');
  // First three fields are little-endian.
  return Buffer.concat([Buffer.from(b.subarray(0, 4)).reverse(), Buffer.from(b.subarray(4, 6)).reverse(), Buffer.from(b.subarray(6, 8)).reverse(), b.subarray(8)]);
}
function bufToGuid(b) {
  const r = (s, e) => Buffer.from(b.subarray(s, e)).reverse().toString('hex');
  return `${r(0, 4)}-${r(4, 6)}-${r(6, 8)}-${b.subarray(8, 10).toString('hex')}-${b.subarray(10, 16).toString('hex')}`;
}

class NamedPropMap {
  /** @param {Map} props PC props of NID_NAME_TO_ID_MAP */
  constructor(props) {
    this.bucketCount = props.get(0x0001)?.value || 251;
    const guidStream = props.get(0x0002)?.value || Buffer.alloc(0);
    const entryStream = props.get(0x0003)?.value || Buffer.alloc(0);
    const stringStream = props.get(0x0004)?.value || Buffer.alloc(0);
    this.guids = [];
    for (let o = 0; o + 16 <= guidStream.length; o += 16) this.guids.push(bufToGuid(guidStream.subarray(o, o + 16)));
    this.stringStream = Buffer.from(stringStream);
    this.entries = []; // { guid, kind:'id'|'name', id|name, propId }
    for (let o = 0; o + 8 <= entryStream.length; o += 8) {
      const dw = entryStream.readUInt32LE(o);
      const w = entryStream.readUInt16LE(o + 4);
      const idx = entryStream.readUInt16LE(o + 6);
      const isString = (w & 1) === 1;
      const g = w >> 1;
      const guid = g === 1 ? PS_MAPI : g === 2 ? PS_PUBLIC_STRINGS : this.guids[g - 3];
      const e = { guid, propId: 0x8000 + idx, guidIndex: g };
      if (isString) {
        const len = this.stringStream.readUInt32LE(dw);
        e.kind = 'name';
        e.name = this.stringStream.toString('utf16le', dw + 4, dw + 4 + len);
        e.strOffset = dw;
      } else {
        e.kind = 'id';
        e.id = dw;
      }
      this.entries.push(e);
    }
    this.dirty = false;
  }

  find(guid, nameOrId) {
    guid = guid.toLowerCase();
    return this.entries.find((e) => e.guid === guid && (typeof nameOrId === 'string' ? e.kind === 'name' && e.name === nameOrId : e.kind === 'id' && e.id === nameOrId));
  }

  /** Property id for a named property, adding it to the map if needed. */
  idFor(guid, nameOrId, create = true) {
    const found = this.find(guid, nameOrId);
    if (found) return found.propId;
    if (!create) return null;
    guid = guid.toLowerCase();
    let g;
    if (guid === PS_MAPI) g = 1;
    else if (guid === PS_PUBLIC_STRINGS) g = 2;
    else {
      let i = this.guids.indexOf(guid);
      if (i < 0) {
        this.guids.push(guid);
        i = this.guids.length - 1;
      }
      g = i + 3;
    }
    const propId = 0x8000 + this.entries.length;
    const e = { guid, propId, guidIndex: g };
    if (typeof nameOrId === 'string') {
      const s = Buffer.from(nameOrId, 'utf16le');
      const len = Buffer.alloc(4);
      len.writeUInt32LE(s.length);
      e.kind = 'name';
      e.name = nameOrId;
      e.strOffset = this.stringStream.length;
      const pad = Buffer.alloc((4 - ((s.length + 4) % 4)) % 4); // keep entries 4-byte aligned
      this.stringStream = Buffer.concat([this.stringStream, len, s, pad]);
    } else {
      e.kind = 'id';
      e.id = nameOrId;
    }
    this.entries.push(e);
    this.dirty = true;
    return propId;
  }

  record(e, forBucket) {
    const b = Buffer.alloc(8);
    const isString = e.kind === 'name';
    let dw = isString ? e.strOffset : e.id;
    if (forBucket && isString) dw = crc32(Buffer.from(e.name, 'utf16le'));
    b.writeUInt32LE(dw >>> 0, 0);
    b.writeUInt16LE(((e.guidIndex << 1) | (isString ? 1 : 0)) & 0xffff, 4);
    b.writeUInt16LE(e.propId - 0x8000, 6);
    return b;
  }

  /** Properties for the NID_NAME_TO_ID_MAP property context. */
  toProps() {
    const { PT } = require('./constants');
    const props = [
      { id: 0x0001, type: PT.LONG, value: this.bucketCount },
      { id: 0x0002, type: PT.BINARY, value: Buffer.concat(this.guids.map(guidToBuf)) },
      { id: 0x0003, type: PT.BINARY, value: Buffer.concat(this.entries.map((e) => this.record(e, false))) },
      { id: 0x0004, type: PT.BINARY, value: this.stringStream },
    ];
    const buckets = new Map();
    for (const e of this.entries) {
      const rec = this.record(e, true);
      const hash = (rec.readUInt32LE(0) ^ rec.readUInt16LE(4)) >>> 0;
      const bucket = hash % this.bucketCount;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push(rec);
    }
    for (const [bucket, recs] of buckets) props.push({ id: 0x1000 + bucket, type: PT.BINARY, value: Buffer.concat(recs) });
    return props;
  }
}

module.exports = { NamedPropMap, PS_MAPI, PS_PUBLIC_STRINGS, guidToBuf, bufToGuid };
