const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { prepareEmailBannerLogo } = require('./prepareEmailBannerLogo');

const KHANA_EMAIL_DIR = path.join(__dirname, '../public/email');
const CLIENT_EMAIL_LOGO_DIR = path.join(__dirname, '../public/uploads/email-logos');

function contentTypeForLogoFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml';
  return 'image/jpeg';
}

function resolveUnderPublicPath(trimmed, marker, uploadDir) {
  if (/^https?:\/\//i.test(trimmed)) {
    const u = new URL(trimmed);
    const idx = u.pathname.indexOf(marker);
    if (idx === -1) return null;
    const base = path.basename(u.pathname.slice(idx + marker.length));
    if (!base || base.includes('..')) return null;
    const full = path.join(uploadDir, base);
    return fs.existsSync(full) ? full : null;
  }
  if (trimmed.startsWith(marker)) {
    const base = path.basename(trimmed.slice(marker.length));
    if (!base || base.includes('..')) return null;
    const full = path.join(uploadDir, base);
    return fs.existsSync(full) ? full : null;
  }
  return null;
}

function resolveLocalEmailBannerFileFromImgSrc(src) {
  if (!src || typeof src !== 'string' || src.startsWith('cid:')) return null;
  const trimmed = src.trim();
  try {
    return (
      resolveUnderPublicPath(trimmed, '/public/email/', KHANA_EMAIL_DIR) ||
      resolveUnderPublicPath(trimmed, '/public/uploads/email-logos/', CLIENT_EMAIL_LOGO_DIR)
    );
  } catch (_) {
    return null;
  }
}

function isHostedEmailBannerLogoUrl(src) {
  if (!src || typeof src !== 'string' || src.startsWith('cid:')) return false;
  if (!/^https?:\/\//i.test(src)) return false;
  return (
    /\/public\/email\//i.test(src) ||
    /\/public\/uploads\/email-logos\//i.test(src)
  );
}


async function fetchRemoteLogoBuffer(src) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(src, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new Error('Image too large');
    return buf;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Inline banner logos as cid attachments.
 * Logos are flattened onto the banner gradient slice so Gmail/Outlook do not
 * render gray/black boxes behind transparent PNGs.
 */
async function inlineEmailBannerLogosAsync(html, baseAttachments, options = {}) {
  const attachments = Array.isArray(baseAttachments) ? [...baseAttachments] : [];
  if (!html || typeof html !== 'string') return { html, attachments };

  const srcToCid = new Map();
  let cidSeq = 0;
  const imgTagRegex = /<img\b([^>]*?)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>/gi;
  const tags = [...html.matchAll(imgTagRegex)];

  for (const match of tags) {
    const src = String(match[3] || '').trim();
    if (!src || src.startsWith('cid:')) continue;

    let content = null;
    let filename = 'email-logo.png';
    let contentType = 'image/png';
    let originalname = path.basename(src.split('?')[0] || 'logo.png');

    const filePath = resolveLocalEmailBannerFileFromImgSrc(src);
    if (filePath) {
      try {
        content = fs.readFileSync(filePath);
        filename = path.basename(filePath);
        contentType = contentTypeForLogoFile(filePath);
        originalname = filename;
      } catch (e) {
        console.warn('Email banner logo inline skipped:', e.message);
        continue;
      }
    } else if (isHostedEmailBannerLogoUrl(src)) {
      try {
        content = await fetchRemoteLogoBuffer(src);
        let ext = '.png';
        try {
          ext = path.extname(new URL(src).pathname) || '.png';
        } catch (_) {
          /* ignore */
        }
        filename = `email-logo${ext}`;
        contentType = contentTypeForLogoFile(`file${ext}`);
        originalname = filename;
      } catch (e) {
        console.warn('Remote email banner logo inline skipped:', src, e.message);
        continue;
      }
    } else {
      continue;
    }

    try {
      content = await prepareEmailBannerLogo(content, {
        originalname,
        mimetype: contentType,
        mode: 'email',
        primaryColor: options.primaryColor,
        bannerWidth: options.bannerWidth,
        logoDisplayWidth: options.logoDisplayWidth,
      });
      contentType = 'image/png';
      filename = `${path.parse(filename).name}.png`;
    } catch (e) {
      console.warn('Email banner logo prepare skipped:', e.message);
    }

    if (!srcToCid.has(src)) {
      const cid = `kclogo${cidSeq++}`;
      srcToCid.set(src, cid);
      attachments.push({ filename, content, contentType, cid });
    }
  }

  const newHtml = html.replace(imgTagRegex, (full, pre, q, srcRaw, post) => {
    const src = String(srcRaw || '').trim();
    const cid = srcToCid.get(src);
    if (!cid) return full;
    return `<img${pre}src=${q}cid:${cid}${q}${post}>`;
  });

  return { html: newHtml, attachments };
}

module.exports = {
  inlineEmailBannerLogosAsync,
  resolveLocalEmailBannerFileFromImgSrc,
};
