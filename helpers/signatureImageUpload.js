const fs = require('fs');
const path = require('path');
const { githubUploadConfigured, uploadBufferToGitHub } = require('./githubUpload');

const SIGNATURES_UPLOAD_DIR = path.join(__dirname, '../public/uploads/signatures');

function requestOrigin(req) {
  if (!req || typeof req.get !== 'function') return '';
  const host = req.get('host');
  if (!host) return '';
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${host}`.replace(/\/$/, '');
}

function safeSignatureExt(originalname, mimetype) {
  const fromName = (path.extname(originalname || '') || '').toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(fromName)) {
    return fromName === '.jpeg' ? '.jpg' : fromName;
  }
  if (mimetype === 'image/png') return '.png';
  if (mimetype === 'image/gif') return '.gif';
  if (mimetype === 'image/webp') return '.webp';
  return '.jpg';
}

/**
 * Persist a dashboard signature image. Prefer GitHub (survives Render redeploys);
 * fall back to local disk under public/uploads/signatures.
 */
async function uploadSignatureImage(buffer, originalname, clientID, req, mimetype = '') {
  if (!buffer || !buffer.length) {
    throw new Error('No image data received');
  }

  const ext = safeSignatureExt(originalname, mimetype);
  const safeId = String(clientID || 'client').replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `${safeId}-${Date.now()}${ext}`;
  const repoPath = `public/uploads/signatures/${fileName}`;

  if (githubUploadConfigured()) {
    const url = await uploadBufferToGitHub(buffer, repoPath);
    return { url, fileName, publicPath: `/public/uploads/signatures/${fileName}`, storage: 'github' };
  }

  fs.mkdirSync(SIGNATURES_UPLOAD_DIR, { recursive: true });
  const fullPath = path.join(SIGNATURES_UPLOAD_DIR, fileName);
  fs.writeFileSync(fullPath, buffer);

  const base = (process.env.BASE_URL || requestOrigin(req) || '').replace(/\/$/, '');
  const publicPath = `/public/uploads/signatures/${fileName}`;
  const url = base ? `${base}${publicPath}` : publicPath;

  return { url, fileName, publicPath, storage: 'disk', localPath: fullPath };
}

module.exports = {
  SIGNATURES_UPLOAD_DIR,
  uploadSignatureImage,
};
