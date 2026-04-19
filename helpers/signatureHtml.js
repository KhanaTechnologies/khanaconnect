/**
 * Email signature handling: supports HTML (including <img>, GIFs), bare image URLs, or plain text.
 * Strips obvious inline script/event handlers; signatures are trusted admin content but not arbitrary XSS.
 */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripInlineRisks(html) {
  return String(html)
    .replace(/<\/script/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\s(on\w+|formaction|javascript:|data:text\/html)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ' ');
}

/** Single-line or simple URL that is clearly an image asset */
function isBareImageUrl(s) {
  const t = String(s).trim();
  if (!/^https?:\/\/\S+$/i.test(t)) return false;
  return /\.(gif|png|jpe?g|webp|svg|bmp|ico)(\?[\w\-=&%.]*)?$/i.test(t);
}

/**
 * True when the client likely intended HTML (tags, entities, or bare image URL).
 */
function signatureLooksRich(sig) {
  const s = String(sig).trim();
  if (!s) return false;
  if (isBareImageUrl(s)) return true;
  if (/&(#\d+|[a-z]+);/i.test(s)) return true;
  return /<\s*\/?\s*[a-z!?]/i.test(s);
}

/**
 * Returns HTML fragment (wrapped) and a short plain-text fallback for multipart/alternative.
 */
function formatSignatureBlock(signature) {
  const sig = String(signature || '').trim();
  if (!sig) return { html: '', text: '' };

  let inner;
  if (isBareImageUrl(sig)) {
    const safe = escapeHtml(sig);
    inner = `<img src="${safe}" alt="" style="max-width:520px;height:auto;display:block;border:0;" />`;
  } else if (signatureLooksRich(sig)) {
    inner = stripInlineRisks(sig);
  } else {
    inner = escapeHtml(sig).replace(/\n/g, '<br/>');
  }

  const textFallback = sig.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  return {
    html: `<div class="crm-signature" style="margin-top:1em">${inner}</div>`,
    text: textFallback,
  };
}

function mergeEmailSignature(html, text, signature) {
  if (!signature || !String(signature).trim()) {
    const t =
      text ||
      (html || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return { html: html || '', text: t };
  }

  const sigBlock = formatSignatureBlock(signature);
  const mergedHtml = `${html || ''}${html ? '<br><br>' : ''}${sigBlock.html}`;
  const baseText =
    text ||
    (html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .trim();
  const mergedText = `${baseText}${baseText ? '\n\n--\n' : ''}${sigBlock.text}`;
  return { html: mergedHtml, text: mergedText };
}

module.exports = {
  mergeEmailSignature,
  formatSignatureBlock,
  signatureLooksRich,
  isBareImageUrl,
  escapeHtml,
  stripInlineRisks,
};
