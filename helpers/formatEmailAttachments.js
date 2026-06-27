/** Map cid attachments for nodemailer — inline only, never listed as file attachments. */
function formatEmailAttachments(attachments) {
  return (attachments || []).map((att) => {
    if (!att || typeof att !== 'object') return att;
    if (!att.cid) return att;
    return {
      filename: att.filename,
      content: att.content,
      contentType: att.contentType,
      cid: String(att.cid).replace(/^<|>$/g, ''),
      contentDisposition: 'inline',
    };
  });
}

module.exports = {
  formatEmailAttachments,
};
