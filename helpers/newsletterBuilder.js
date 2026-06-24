const { uploadPublicAsset } = require('./publicAssetUpload');

const FILE_TYPE_MAP = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const MAX_HTML_BYTES = 512 * 1024;

function buildFileName(ext) {
  return `newsletter-${Date.now()}-${Math.random().toString(36).substring(2, 10)}.${ext}`;
}

async function uploadNewsletterImage(file, req) {
  const mime = file.mimetype || '';
  const ext = FILE_TYPE_MAP[mime];
  if (!ext) {
    throw new Error('Invalid file type. Use PNG, JPEG, GIF, or WebP.');
  }
  if (!file.buffer || !file.buffer.length) {
    throw new Error('No image data received');
  }

  const fileName = buildFileName(ext);
  const uploaded = await uploadPublicAsset(file.buffer, `public/uploads/${fileName}`, req);
  return {
    url: uploaded.url,
    fileName: uploaded.fileName,
  };
}

function stripDangerousHtml(html) {
  let out = String(html || '');
  out = out.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  out = out.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/href\s*=\s*("|\')\s*javascript:[^"\']*\1/gi, 'href="#"');
  out = out.replace(/src\s*=\s*("|\')\s*javascript:[^"\']*\1/gi, 'src=""');
  return out;
}

function htmlToPlainText(html) {
  return String(html || '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);
}

/**
 * Validate HTML composed by the dashboard builder before preview/send.
 */
function validateNewsletterHtml(html) {
  const warnings = [];
  const raw = String(html || '').trim();

  if (!raw) {
    return { ok: false, error: 'HTML body is required', html: '', text: '', warnings };
  }

  if (Buffer.byteLength(raw, 'utf8') > MAX_HTML_BYTES) {
    return {
      ok: false,
      error: `HTML exceeds maximum size (${MAX_HTML_BYTES} bytes)`,
      html: '',
      text: '',
      warnings,
    };
  }

  if (/<script\b/i.test(raw)) {
    warnings.push('Removed script tags from HTML');
  }
  if (/\son\w+\s*=/i.test(raw)) {
    warnings.push('Removed inline event handlers from HTML');
  }

  const sanitized = stripDangerousHtml(raw);
  const text = htmlToPlainText(sanitized);

  if (!text && !/<img\b/i.test(sanitized)) {
    warnings.push('HTML appears to have very little visible content');
  }

  return {
    ok: true,
    html: sanitized,
    text,
    warnings,
  };
}

module.exports = {
  FILE_TYPE_MAP,
  uploadNewsletterImage,
  validateNewsletterHtml,
  htmlToPlainText,
};
