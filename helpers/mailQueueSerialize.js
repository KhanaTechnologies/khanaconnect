/**
 * JSON-safe mail payload for BullMQ outbound-email jobs (no Buffers / functions).
 */

function serializeMailOptions(mailOptions) {
  if (!mailOptions || typeof mailOptions !== 'object') return {};
  const allow = ['from', 'to', 'cc', 'bcc', 'subject', 'text', 'html', 'replyTo', 'inReplyTo', 'references', 'sender'];
  const out = {};
  for (const k of allow) {
    if (mailOptions[k] !== undefined) out[k] = mailOptions[k];
  }
  if (Array.isArray(mailOptions.attachments) && mailOptions.attachments.length) {
    out.attachments = mailOptions.attachments.map((a) => {
      if (!a || typeof a !== 'object') return a;
      const att = {
        filename: a.filename,
        contentType: a.contentType,
        encoding: a.encoding,
        cid: a.cid,
      };
      if (Buffer.isBuffer(a.content)) att.contentBase64 = a.content.toString('base64');
      else if (typeof a.content === 'string') att.content = a.content;
      return att;
    });
  }
  return out;
}

function deserializeMailOptions(data) {
  if (!data || typeof data !== 'object') return {};
  const o = { ...data };
  if (Array.isArray(o.attachments)) {
    o.attachments = o.attachments.map((a) => {
      if (!a || typeof a !== 'object') return a;
      const copy = { ...a };
      if (copy.contentBase64) {
        copy.content = Buffer.from(String(copy.contentBase64), 'base64');
        delete copy.contentBase64;
      }
      return copy;
    });
  }
  return o;
}

module.exports = {
  serializeMailOptions,
  deserializeMailOptions,
};
