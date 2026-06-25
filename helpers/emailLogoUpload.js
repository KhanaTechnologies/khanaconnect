const path = require('path');
const { uploadPublicAsset } = require('./publicAssetUpload');

function safeLogoExt(originalname, mimetype) {
  const fromName = (path.extname(originalname || '') || '').toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(fromName)) {
    return fromName === '.jpeg' ? '.jpg' : fromName;
  }
  if (mimetype === 'image/png') return '.png';
  if (mimetype === 'image/gif') return '.gif';
  if (mimetype === 'image/webp') return '.webp';
  if (mimetype === 'image/svg+xml') return '.svg';
  return '.jpg';
}

async function uploadEmailLogoImage(buffer, originalname, clientID, req, mimetype = '') {
  const ext = safeLogoExt(originalname, mimetype);
  const safeId = String(clientID || 'client').replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `${safeId}-${Date.now()}${ext}`;
  const repoPath = `public/uploads/email-logos/${fileName}`;
  return uploadPublicAsset(buffer, repoPath, req);
}

module.exports = {
  uploadEmailLogoImage,
};
