'use strict';
// Builds outgoing RFC 822 messages for Gmail's send endpoint.

const fs = require('fs');
const path = require('path');
const MailComposer = require('nodemailer/lib/mail-composer');

/**
 * @param {object} draft { from, to, cc, bcc, subject, html, text, inReplyTo, references, attachments:[filePath] }
 * @returns {Promise<Buffer>}
 */
function buildMime(draft) {
  const mail = new MailComposer({
    from: draft.from,
    to: draft.to,
    cc: draft.cc || undefined,
    bcc: draft.bcc || undefined,
    subject: draft.subject || '',
    html: draft.html || undefined,
    text: draft.text || undefined,
    inReplyTo: draft.inReplyTo || undefined,
    references: draft.references || undefined,
    attachments: (draft.attachments || []).map((p) => ({ filename: path.basename(p), content: fs.createReadStream(p) })),
  });
  return new Promise((resolve, reject) => mail.compile().build((err, msg) => (err ? reject(err) : resolve(msg))));
}

module.exports = { buildMime };
