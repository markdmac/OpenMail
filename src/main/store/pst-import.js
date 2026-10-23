'use strict';
// Imports another PST (Unicode or old ANSI) into the open mailbox: folders, messages, recipients and
// attachments are copied property-for-property, so non-mail items (calendar, contacts) survive too.

const { PstStore, P, tableNid } = require('../pst/pst-store');
const { readPC, readTC } = require('../pst/ltp');
const { PT, NID, NID_TYPE } = require('../pst/constants');

const STRING_UPGRADE = { [PT.STRING8]: PT.UNICODE, [PT.MV_STRING8]: PT.MV_UNICODE };
// Properties that describe the source file's internals rather than the item.
const SKIP = new Set([0x0e33, 0x0e34, 0x0e38, 0x0e30, 0x67f2, 0x67f3, 0x0e3c, 0x0e3d]);

/**
 * @param {PstStore} dest open, writable store
 * @param {string} srcPath PST to import
 * @param {{targetPrefix?:string, skipDuplicates?:boolean, onProgress?:Function, commit?:Function, commitEvery?:number}} opts
 */
function importPst(dest, srcPath, opts = {}) {
  const src = PstStore.open(srcPath, { readOnly: true });
  const counts = { folders: 0, messages: 0, duplicates: 0, skipped: 0, errors: 0, embeddedSkipped: 0 };
  try {
    const mapNamed = makeNamedMapper(src, dest);
    const tree = src.folderTree();
    const total = sumCounts(tree);
    let done = 0;
    let sinceCommit = 0;
    const progress = (folder) => opts.onProgress && opts.onProgress({ done, total, folder, ...counts });

    const walk = (nodes, destParentPath) => {
      for (const f of nodes) {
        const destPath = destParentPath ? `${destParentPath}/${f.name}` : f.name;
        let destNid = dest.findFolderByPath(destPath, false);
        if (!destNid) {
          const parentNid = destParentPath ? dest.findFolderByPath(destParentPath, true) : dest.ipmSubtree;
          destNid = dest.createFolder(parentNid, f.name, f.containerClass || 'IPF.Note');
          counts.folders++;
        }
        const existing = opts.skipDuplicates ? new Set(dest.listMessages(destNid).map(dupKey)) : null;
        for (const m of src.listMessages(f.nid)) {
          done++;
          if (existing && existing.has(dupKey(m))) {
            counts.duplicates++;
            continue;
          }
          try {
            copyMessage(src, m.nid, dest, destNid, mapNamed, counts);
            counts.messages++;
            if (existing) existing.add(dupKey(m));
          } catch (e) {
            counts.errors++;
            if (opts.onProgress) opts.onProgress({ done, total, folder: destPath, error: `${m.subject}: ${e.message}`, ...counts });
          }
          if (++sinceCommit >= (opts.commitEvery || 100)) {
            sinceCommit = 0;
            if (opts.commit) opts.commit();
            progress(destPath);
          }
        }
        progress(destPath);
        walk(f.children, destPath);
      }
    };
    walk(tree, opts.targetPrefix || '');
    return { ...counts, total };
  } finally {
    src.close();
  }
}

function sumCounts(nodes) {
  return nodes.reduce((s, f) => s + f.count + sumCounts(f.children), 0);
}

function dupKey(m) {
  return `${m.subject}|${m.from}|${m.date ? m.date.getTime() : ''}`;
}

/** Maps a named property id in the source store to the matching id in the destination store. */
function makeNamedMapper(src, dest) {
  const cache = new Map();
  return (id) => {
    if (id < 0x8000) return id;
    if (cache.has(id)) return cache.get(id);
    const e = src.named.entries.find((x) => x.propId === id);
    const mapped = e ? dest.named.idFor(e.guid, e.kind === 'name' ? e.name : e.id, true) : null;
    cache.set(id, mapped);
    return mapped;
  };
}

function convertProps(props, mapNamed) {
  const out = [];
  for (const [id, p] of props) {
    if (SKIP.has(id) || p.value === null || p.value === undefined || p.error) continue;
    const nid = mapNamed(id);
    if (nid === null) continue;
    out.push({ id: nid, type: STRING_UPGRADE[p.type] || p.type, value: p.value });
  }
  return out;
}

function copyMessage(src, srcNid, dest, destFolder, mapNamed, counts) {
  const node = src.ndb.getNode(srcNid);
  const { props, subnodes } = readPC(src.ndb, node);
  const destProps = convertProps(props, mapNamed);
  const outSubs = [];

  // Recipients.
  const rsub = subnodes.get(NID.RECIPIENT_TABLE);
  if (rsub) {
    const t = readTC(src.ndb, rsub);
    const cols = mergeColumns(dest.templateColumns(NID.RECIPIENT_TABLE, []), t.columns, mapNamed);
    const rows = t.rows.map((values, i) => ({ rowId: t.rowIds[i] ?? i, values: remapRow(values, mapNamed) }));
    outSubs.push(dest.tableSubnode(NID.RECIPIENT_TABLE, cols, rows));
  } else {
    outSubs.push(dest.tableSubnode(NID.RECIPIENT_TABLE, dest.templateColumns(NID.RECIPIENT_TABLE, []), []));
  }

  // Attachments.
  const asub = subnodes.get(NID.ATTACHMENT_TABLE);
  if (asub) {
    const t = readTC(src.ndb, asub);
    const attRows = [];
    t.rowIds.forEach((anid, i) => {
      const sn = subnodes.get(anid);
      if (!sn) return;
      const { props: aprops, subnodes: asubs } = readPC(src.ndb, sn);
      const isObject = aprops.get(P.ATTACH_DATA)?.type === PT.OBJECT;
      const extraSubs = [];
      if (isObject) {
        // Embedded message (e.g. forwarded as attachment): copy its subtree when the formats match.
        if (!src.isUnicode) {
          counts.embeddedSkipped++;
          return;
        }
        const ref = aprops.get(P.ATTACH_DATA).value;
        const objNid = Buffer.isBuffer(ref) ? ref.readUInt32LE(0) : 0;
        const objSub = asubs.get(objNid);
        if (objSub) extraSubs.push({ nid: objNid, ...copySubtree(src.ndb, dest.ndb, objSub) });
      }
      const newNid = dest.allocNid(NID_TYPE.ATTACHMENT);
      const list = convertProps(aprops, mapNamed);
      const pcSubs = [];
      const pages = require('../pst/ltp').buildPC(list, (data) => {
        const snid = dest.allocNid(NID_TYPE.LTP);
        pcSubs.push({ nid: snid, bidData: dest.ndb.writeDataTree(data), bidSub: 0 });
        return snid;
      });
      outSubs.push({ nid: newNid, bidData: dest.ndb.writeDataTree(pages), bidSub: dest.ndb.writeSubnodeTree([...pcSubs, ...extraSubs]) });
      attRows.push({ rowId: newNid, values: remapRow(t.rows[i], mapNamed) });
    });
    if (attRows.length) {
      const cols = mergeColumns(dest.templateColumns(NID.ATTACHMENT_TABLE, []), t.columns, mapNamed);
      outSubs.push(dest.tableSubnode(NID.ATTACHMENT_TABLE, cols, attRows));
    }
  }

  const unread = !((props.get(P.MESSAGE_FLAGS)?.value || 0) & 1);
  return dest.addRawMessage(destFolder, destProps, outSubs, unread);
}

function remapRow(values, mapNamed) {
  const out = new Map();
  for (const [id, v] of values) {
    if (id === 0x67f2 || id === 0x67f3) continue;
    const nid = mapNamed(id);
    if (nid !== null) out.set(nid, v);
  }
  return out;
}

function mergeColumns(base, srcColumns, mapNamed) {
  const cols = [...base];
  const have = new Set(cols.map(([id]) => id));
  for (const c of srcColumns) {
    const id = mapNamed(c.id);
    if (id === null || have.has(id)) continue;
    cols.push([id, STRING_UPGRADE[c.type] || c.type]);
    have.add(id);
  }
  if (!have.has(0x67f2)) cols.push([0x67f2, PT.LONG]);
  if (!have.has(0x67f3)) cols.push([0x67f3, PT.LONG]);
  return cols;
}

/** Copies a node's data and subnode trees block-for-block into another (Unicode) file. */
function copySubtree(srcNdb, destNdb, sub) {
  const bidData = sub.bidData ? destNdb.writeDataTree(srcNdb.readDataBlocks(sub.bidData)) : 0;
  const children = [...srcNdb.readSubnodes(sub.bidSub).values()].map((c) => ({ nid: c.nid, ...copySubtree(srcNdb, destNdb, c) }));
  return { bidData, bidSub: destNdb.writeSubnodeTree(children) };
}

module.exports = { importPst };
