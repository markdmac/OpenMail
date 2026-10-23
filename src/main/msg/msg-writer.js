'use strict';
// Builds Outlook .msg files (MS-OXMSG) from a parsed internet message so that
// Outlook can open them with Namespace.OpenSharedItem and move them into a PST.

const { CompoundFile } = require('./cfb-writer');

const PT_LONG = 0x0003;
const PT_BOOLEAN = 0x000b;
const PT_SYSTIME = 0x0040;
const PT_UNICODE = 0x001f;
const PT_BINARY = 0x0102;

const P = {
  IMPORTANCE: [0x0017, PT_LONG],
  MESSAGE_CLASS: [0x001a, PT_UNICODE],
  SUBJECT: [0x0037, PT_UNICODE],
  CLIENT_SUBMIT_TIME: [0x0039, PT_SYSTIME],
  SUBJECT_PREFIX: [0x003d, PT_UNICODE],
  SENT_REPRESENTING_NAME: [0x0042, PT_UNICODE],
  SENT_REPRESENTING_ADDRTYPE: [0x0064, PT_UNICODE],
  SENT_REPRESENTING_EMAIL_ADDRESS: [0x0065, PT_UNICODE],
  CONVERSATION_TOPIC: [0x0070, PT_UNICODE],
  TRANSPORT_MESSAGE_HEADERS: [0x007d, PT_UNICODE],
  SENDER_NAME: [0x0c1a, PT_UNICODE],
  SENDER_ADDRTYPE: [0x0c1e, PT_UNICODE],
  SENDER_EMAIL_ADDRESS: [0x0c1f, PT_UNICODE],
  RECIPIENT_TYPE: [0x0c15, PT_LONG],
  DISPLAY_BCC: [0x0e02, PT_UNICODE],
  DISPLAY_CC: [0x0e03, PT_UNICODE],
  DISPLAY_TO: [0x0e04, PT_UNICODE],
  MESSAGE_DELIVERY_TIME: [0x0e06, PT_SYSTIME],
  MESSAGE_FLAGS: [0x0e07, PT_LONG],
  HASATTACH: [0x0e1b, PT_BOOLEAN],
  NORMALIZED_SUBJECT: [0x0e1d, PT_UNICODE],
  ATTACH_SIZE: [0x0e20, PT_LONG],
  ATTACH_NUM: [0x0e21, PT_LONG],
  OBJECT_TYPE: [0x0ffe, PT_LONG],
  BODY: [0x1000, PT_UNICODE],
  HTML: [0x1013, PT_BINARY],
  INTERNET_MESSAGE_ID: [0x1035, PT_UNICODE],
  INTERNET_REFERENCES: [0x1039, PT_UNICODE],
  IN_REPLY_TO_ID: [0x1042, PT_UNICODE],
  FLAG_STATUS: [0x1090, PT_LONG],
  ROWID: [0x3000, PT_LONG],
  DISPLAY_NAME: [0x3001, PT_UNICODE],
  ADDRTYPE: [0x3002, PT_UNICODE],
  EMAIL_ADDRESS: [0x3003, PT_UNICODE],
  CREATION_TIME: [0x3007, PT_SYSTIME],
  LAST_MODIFICATION_TIME: [0x3008, PT_SYSTIME],
  STORE_SUPPORT_MASK: [0x340d, PT_LONG],
  ATTACH_DATA_BIN: [0x3701, PT_BINARY],
  ATTACH_EXTENSION: [0x3703, PT_UNICODE],
  ATTACH_FILENAME: [0x3704, PT_UNICODE],
  ATTACH_METHOD: [0x3705, PT_LONG],
  ATTACH_LONG_FILENAME: [0x3707, PT_UNICODE],
  RENDERING_POSITION: [0x370b, PT_LONG],
  ATTACH_MIME_TAG: [0x370e, PT_UNICODE],
  ATTACH_CONTENT_ID: [0x3712, PT_UNICODE],
  ATTACH_FLAGS: [0x3714, PT_LONG],
  DISPLAY_TYPE: [0x3900, PT_LONG],
  SMTP_ADDRESS: [0x39fe, PT_UNICODE],
  MESSAGE_CODEPAGE: [0x3ffd, PT_LONG],
  INTERNET_CPID: [0x3fde, PT_LONG],
  SENDER_SMTP_ADDRESS: [0x5d01, PT_UNICODE],
  SENT_REPRESENTING_SMTP_ADDRESS: [0x5d02, PT_UNICODE],
  RECIPIENT_DISPLAY_NAME: [0x5ff6, PT_UNICODE],
  ATTACHMENT_HIDDEN: [0x7ffe, PT_BOOLEAN],
};

const MSGFLAG_READ = 0x01;
const MSGFLAG_HASATTACH = 0x10;
const STORE_UNICODE_OK = 0x00040000;
const ATT_MHTML_REF = 0x4;

class PropertyBag {
  constructor() {
    this.props = [];
  }
  set([id, type], value) {
    if (value === undefined || value === null) return this;
    if (type === PT_UNICODE && value === '') return this;
    this.props.push({ id, type, value });
    return this;
  }
  // Writes the __properties_version1.0 stream plus one stream per variable-length value.
  writeTo(storage, headerSize, headerFill) {
    const buf = Buffer.alloc(headerSize + this.props.length * 16);
    if (headerFill) headerFill(buf);
    this.props.forEach((p, i) => {
      const off = headerSize + i * 16;
      buf.writeUInt32LE(((p.id << 16) | p.type) >>> 0, off);
      buf.writeUInt32LE(0x6, off + 4); // PROPATTR_READABLE | PROPATTR_WRITABLE
      const streamName = `__substg1.0_${hex4(p.id)}${hex4(p.type)}`;
      switch (p.type) {
        case PT_LONG:
          buf.writeInt32LE(p.value | 0, off + 8);
          break;
        case PT_BOOLEAN:
          buf.writeUInt16LE(p.value ? 1 : 0, off + 8);
          break;
        case PT_SYSTIME:
          buf.writeBigUInt64LE(toFileTime(p.value), off + 8);
          break;
        case PT_UNICODE: {
          const data = Buffer.from(String(p.value).replace(/\0/g, '') + '\0', 'utf16le');
          buf.writeUInt32LE(data.length, off + 8);
          storage.stream(streamName, data);
          break;
        }
        case PT_BINARY: {
          const data = Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value);
          buf.writeUInt32LE(data.length, off + 8);
          storage.stream(streamName, data);
          break;
        }
        default:
          throw new Error(`Unsupported property type 0x${p.type.toString(16)}`);
      }
    });
    storage.stream('__properties_version1.0', buf);
  }
}

/**
 * @param {object} m normalized message:
 *   { subject, from:{name,address}, to:[], cc:[], bcc:[], date:Date, receivedDate:Date,
 *     text, html, headers, messageId, inReplyTo, references, importance, unread, flagged,
 *     attachments:[{filename, contentType, content:Buffer, contentId, inline}] }
 * @returns {Buffer} .msg file contents
 */
function buildMsg(m) {
  const cf = new CompoundFile();
  const root = cf.root;

  const subject = m.subject || '';
  const sent = m.date || new Date();
  const received = m.receivedDate || sent;
  const from = m.from || { name: '', address: '' };
  const to = m.to || [];
  const cc = m.cc || [];
  const bcc = m.bcc || [];
  const attachments = m.attachments || [];

  const props = new PropertyBag();
  props
    .set(P.MESSAGE_CLASS, 'IPM.Note')
    .set(P.STORE_SUPPORT_MASK, STORE_UNICODE_OK)
    .set(P.SUBJECT, subject)
    .set(P.SUBJECT_PREFIX, '')
    .set(P.NORMALIZED_SUBJECT, normalizeSubject(subject))
    .set(P.CONVERSATION_TOPIC, normalizeSubject(subject))
    .set(P.CLIENT_SUBMIT_TIME, sent)
    .set(P.MESSAGE_DELIVERY_TIME, received)
    .set(P.CREATION_TIME, received)
    .set(P.LAST_MODIFICATION_TIME, received)
    .set(P.MESSAGE_FLAGS, (m.unread ? 0 : MSGFLAG_READ) | (attachments.length ? MSGFLAG_HASATTACH : 0))
    .set(P.HASATTACH, attachments.length > 0)
    .set(P.IMPORTANCE, { low: 0, normal: 1, high: 2 }[m.importance] ?? 1)
    .set(P.SENDER_NAME, from.name || from.address)
    .set(P.SENDER_EMAIL_ADDRESS, from.address)
    .set(P.SENDER_ADDRTYPE, 'SMTP')
    .set(P.SENDER_SMTP_ADDRESS, from.address)
    .set(P.SENT_REPRESENTING_NAME, from.name || from.address)
    .set(P.SENT_REPRESENTING_EMAIL_ADDRESS, from.address)
    .set(P.SENT_REPRESENTING_ADDRTYPE, 'SMTP')
    .set(P.SENT_REPRESENTING_SMTP_ADDRESS, from.address)
    .set(P.DISPLAY_TO, displayList(to))
    .set(P.DISPLAY_CC, displayList(cc))
    .set(P.DISPLAY_BCC, displayList(bcc))
    .set(P.TRANSPORT_MESSAGE_HEADERS, m.headers)
    .set(P.INTERNET_MESSAGE_ID, m.messageId)
    .set(P.IN_REPLY_TO_ID, m.inReplyTo)
    .set(P.INTERNET_REFERENCES, m.references)
    .set(P.BODY, m.text || (m.html ? htmlToText(m.html) : ''))
    .set(P.INTERNET_CPID, 65001)
    .set(P.MESSAGE_CODEPAGE, 65001);
  if (m.html) props.set(P.HTML, Buffer.from(m.html, 'utf8'));
  if (m.flagged) props.set(P.FLAG_STATUS, 2);

  const recipients = [
    ...to.map((r) => [r, 1]),
    ...cc.map((r) => [r, 2]),
    ...bcc.map((r) => [r, 3]),
  ];

  props.writeTo(root, 32, (buf) => {
    buf.writeUInt32LE(recipients.length, 8); // next recipient id
    buf.writeUInt32LE(attachments.length, 12); // next attachment id
    buf.writeUInt32LE(recipients.length, 16);
    buf.writeUInt32LE(attachments.length, 20);
  });

  // Named property mapping storage is mandatory, even when empty.
  root
    .storage('__nameid_version1.0')
    .stream('__substg1.0_00020102', Buffer.alloc(0))
    .stream('__substg1.0_00030102', Buffer.alloc(0))
    .stream('__substg1.0_00040102', Buffer.alloc(0));

  recipients.forEach(([r, type], i) => {
    const s = root.storage(`__recip_version1.0_#${hex8(i)}`);
    const name = r.name || r.address || '';
    new PropertyBag()
      .set(P.ROWID, i)
      .set(P.RECIPIENT_TYPE, type)
      .set(P.OBJECT_TYPE, 6) // MAPI_MAILUSER
      .set(P.DISPLAY_TYPE, 0)
      .set(P.DISPLAY_NAME, name)
      .set(P.RECIPIENT_DISPLAY_NAME, name)
      .set(P.ADDRTYPE, 'SMTP')
      .set(P.EMAIL_ADDRESS, r.address)
      .set(P.SMTP_ADDRESS, r.address)
      .writeTo(s, 8);
  });

  attachments.forEach((a, i) => {
    const s = root.storage(`__attach_version1.0_#${hex8(i)}`);
    const filename = a.filename || `attachment${i + 1}${extFor(a.contentType)}`;
    const ext = (filename.match(/\.[^.]+$/) || [''])[0];
    const content = a.content || Buffer.alloc(0);
    const bag = new PropertyBag()
      .set(P.ATTACH_NUM, i)
      .set(P.OBJECT_TYPE, 7) // MAPI_ATTACH
      .set(P.ATTACH_METHOD, 1) // ATTACH_BY_VALUE
      .set(P.RENDERING_POSITION, -1)
      .set(P.ATTACH_SIZE, content.length)
      .set(P.DISPLAY_NAME, filename)
      .set(P.ATTACH_LONG_FILENAME, filename)
      .set(P.ATTACH_FILENAME, shortName(filename))
      .set(P.ATTACH_EXTENSION, ext)
      .set(P.ATTACH_MIME_TAG, a.contentType)
      .set(P.ATTACH_DATA_BIN, content);
    if (a.contentId) {
      bag.set(P.ATTACH_CONTENT_ID, a.contentId.replace(/^<|>$/g, ''));
    }
    if (a.inline && a.contentId) {
      bag.set(P.ATTACHMENT_HIDDEN, true).set(P.ATTACH_FLAGS, ATT_MHTML_REF);
    }
    bag.writeTo(s, 8);
  });

  return cf.toBuffer();
}

function toFileTime(date) {
  const ms = BigInt(new Date(date).getTime());
  return (ms + 11644473600000n) * 10000n;
}

function hex4(n) {
  return n.toString(16).toUpperCase().padStart(4, '0');
}
function hex8(n) {
  return n.toString(16).toUpperCase().padStart(8, '0');
}

function normalizeSubject(s) {
  return s.replace(/^((re|fw|fwd|aw|wg|sv|antw)\s*(\[\d+\])?:\s*)+/i, '');
}

function displayList(list) {
  return list.map((r) => r.name || r.address).filter(Boolean).join('; ');
}

function shortName(filename) {
  const m = filename.match(/^(.*?)(\.[^.]*)?$/);
  const base = (m[1] || 'file').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'file';
  const ext = (m[2] || '').replace(/[^A-Za-z0-9.]/g, '').slice(0, 4);
  return (base + ext).toUpperCase();
}

function extFor(contentType = '') {
  const map = {
    'text/plain': '.txt',
    'text/html': '.html',
    'text/calendar': '.ics',
    'message/rfc822': '.eml',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'application/pdf': '.pdf',
  };
  return map[contentType.toLowerCase()] || '.bin';
}

function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { buildMsg, htmlToText };
