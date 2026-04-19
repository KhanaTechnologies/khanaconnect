/**
 * “Template one” — stacked full-width promo blocks (~600px), similar to common retail newsletters.
 * Frontend can drive `blocks` from a grid (each cell → one row with imageUrl + optional linkUrl).
 */

const { escapeHtml } = require('./signatureHtml');

const MAX_BLOCKS = 40;

function isAllowedAssetUrl(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 2048) return false;
  if (/^javascript:/i.test(s) || /^data:/i.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (s.startsWith('/public/uploads/')) return true;
  return false;
}

function isAllowedLinkUrl(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 2048) return false;
  if (/^javascript:/i.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (s.startsWith('/') && !s.startsWith('//')) return true;
  return false;
}

/**
 * @param {object} opts
 * @param {string} [opts.preheader]
 * @param {string} [opts.headline] — optional small headline above blocks
 * @param {string} [opts.introHtml] — optional safe HTML snippet (already trusted / from builder)
 * @param {Array<{ imageUrl: string, linkUrl?: string, alt?: string }>} opts.blocks
 * @param {string} [opts.ctaUrl]
 * @param {string} [opts.ctaLabel]
 * @param {string[]} [opts.footerLines] — plain lines, escaped
 * @param {string} [opts.companyName]
 */
function buildPromotionalTemplateOneHtml(opts = {}) {
  const blocks = Array.isArray(opts.blocks) ? opts.blocks.slice(0, MAX_BLOCKS) : [];
  const preheader = escapeHtml(String(opts.preheader || '').slice(0, 220));
  const headline = escapeHtml(String(opts.headline || '').slice(0, 200));
  const ctaUrl = opts.ctaUrl && isAllowedLinkUrl(opts.ctaUrl) ? String(opts.ctaUrl).trim() : '';
  const ctaLabel = escapeHtml(String(opts.ctaLabel || 'Shop deals').slice(0, 120));
  const company = escapeHtml(String(opts.companyName || '').slice(0, 120));
  const introHtmlRaw =
    typeof opts.introHtml === 'string' && opts.introHtml.trim() ? opts.introHtml.trim().slice(0, 8000) : '';
  const introHtml = introHtmlRaw
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  const footerLines = Array.isArray(opts.footerLines)
    ? opts.footerLines.map((l) => escapeHtml(String(l).slice(0, 500))).filter(Boolean)
    : [];

  const blockRows = blocks
    .map((b) => {
      const imageUrl = b && b.imageUrl ? String(b.imageUrl).trim() : '';
      if (!isAllowedAssetUrl(imageUrl)) return '';
      const alt = escapeHtml(String((b && b.alt) || 'Promotion').slice(0, 200));
      const link = b && b.linkUrl && isAllowedLinkUrl(b.linkUrl) ? String(b.linkUrl).trim() : '';
      const imgTag = `<img src="${escapeHtml(imageUrl)}" alt="${alt}" width="590" style="display:block;height:auto;border:0;width:100%;max-width:590px" />`;
      const inner = link
        ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none">${imgTag}</a>`
        : imgTag;
      return `<tr><td style="padding:6px 5px;vertical-align:top;text-align:center">
  <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;max-width:600px;width:100%"><tr><td style="text-align:center">${inner}</td></tr></table>
</td></tr>`;
    })
    .join('');

  const ctaRow =
    ctaUrl && ctaLabel
      ? `<tr><td style="padding:16px 12px;text-align:center;font-family:Helvetica Neue,Helvetica,Arial,sans-serif">
  <a href="${escapeHtml(ctaUrl)}" target="_blank" rel="noopener noreferrer" style="color:#0f79bf;font-size:16px;font-weight:bold;text-decoration:underline">${ctaLabel}</a>
</td></tr>`
      : '';

  const footerHtml = footerLines.length
    ? `<tr><td style="padding:16px 12px 24px;text-align:center;font-family:Helvetica Neue,Helvetica,Arial,sans-serif;font-size:11px;line-height:1.6;color:#555">
  ${footerLines.map((l) => `<p style="margin:6px 0">${l}</p>`).join('')}
</td></tr>`
    : '';

  const headBlock = headline
    ? `<tr><td style="padding:12px 16px 0;text-align:center;font-family:Helvetica Neue,Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;color:#111">${headline}</td></tr>`
    : '';
  const introRow = introHtml
    ? `<tr><td style="padding:12px 18px 0;text-align:center;font-family:Helvetica Neue,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#333">${introHtml}</td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title></title>
<style type="text/css">body{margin:0;padding:0;background:#ffffff}a img{border:0}</style>
</head>
<body style="margin:0;padding:0;background:#ffffff;-webkit-text-size-adjust:none">
<div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff"><tr><td align="center" style="padding:0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;background:#ffffff">
${company ? `<tr><td style="padding:14px 12px 6px;text-align:center;font-family:Helvetica Neue,Helvetica,Arial,sans-serif;font-size:13px;color:#666">${company}</td></tr>` : ''}
${headBlock}
${introRow}
${blockRows}
${ctaRow}
${footerHtml}
</table>
</td></tr></table>
</body>
</html>`;
}

function buildPromotionalTemplateOneText(opts = {}) {
  const lines = [];
  if (opts.preheader) lines.push(String(opts.preheader));
  if (opts.headline) lines.push(String(opts.headline));
  const blocks = Array.isArray(opts.blocks) ? opts.blocks.slice(0, MAX_BLOCKS) : [];
  for (const b of blocks) {
    const u = b && b.imageUrl ? String(b.imageUrl).trim() : '';
    if (!isAllowedAssetUrl(u)) continue;
    const link = b && b.linkUrl && isAllowedLinkUrl(b.linkUrl) ? String(b.linkUrl).trim() : u;
    const alt = (b && b.alt) || 'Offer';
    lines.push(`${alt}: ${link}`);
  }
  if (opts.ctaUrl && isAllowedLinkUrl(opts.ctaUrl)) lines.push(`${opts.ctaLabel || 'Shop'}: ${opts.ctaUrl}`);
  if (Array.isArray(opts.footerLines)) opts.footerLines.forEach((l) => lines.push(String(l)));
  return lines.join('\n\n').slice(0, 12000);
}

function parsePromoPayload(raw) {
  if (raw == null || raw === '') return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const blocks = Array.isArray(obj.blocks) ? obj.blocks : [];
  return {
    preheader: obj.preheader,
    headline: obj.headline,
    introHtml: obj.introHtml,
    blocks,
    ctaUrl: obj.ctaUrl,
    ctaLabel: obj.ctaLabel,
    footerLines: obj.footerLines,
  };
}

module.exports = {
  buildPromotionalTemplateOneHtml,
  buildPromotionalTemplateOneText,
  parsePromoPayload,
  isAllowedAssetUrl,
  MAX_BLOCKS,
};
