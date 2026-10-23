'use strict';
// Converts a raw RFC 822 message (as returned by Gmail format=raw) into the
// normalized shape consumed by buildMsg().

const { simpleParser } = require('mailparser');

function addrList(field) {
  if (!field) return [];
  const groups = Array.isArray(field) ? field : [field];
  const out = [];
  for (const g of groups) {
    for (const v of g.value || []) {
      if (v.group) v.group.forEach((x) => out.push({ name: x.name || '', address: x.address || '' }));
      else out.push({ name: v.name || '', address: v.address || '' });
    }
  }
  return out;
}

function headerBlock(raw) {
  const s = raw.toString('latin1');
  const end = s.search(/\r?\n\r?\n/);
  return end >= 0 ? s.slice(0, end) : s;
}

async function parseRaw(raw, { internalDate } = {}) {
  const parsed = await simpleParser(raw, { skipTextToHtml: true, skipImageLinks: true, keepCidLinks: true });
  const importanceHeader = String(parsed.headers.get('importance') || parsed.headers.get('x-priority') || '').toLowerCase();
  let importance = 'normal';
  if (/high|^1|^2/.test(importanceHeader)) importance = 'high';
  else if (/low|^4|^5/.test(importanceHeader)) importance = 'low';

  const references = Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references;
  const received = internalDate ? new Date(Number(internalDate)) : parsed.date;

  return {
    subject: parsed.subject || '',
    from: addrList(parsed.from)[0] || { name: '', address: '' },
    to: addrList(parsed.to),
    cc: addrList(parsed.cc),
    bcc: addrList(parsed.bcc),
    date: parsed.date || received || new Date(),
    receivedDate: received || parsed.date || new Date(),
    text: parsed.text || '',
    html: typeof parsed.html === 'string' ? parsed.html : '',
    headers: headerBlock(raw),
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references,
    importance,
    attachments: (parsed.attachments || []).map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: a.content,
      contentId: a.contentId || a.cid,
      inline: a.contentDisposition === 'inline' || (!!a.related && !!a.contentId),
    })),
  };
}

module.exports = { parseRaw };
