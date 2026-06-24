const path = require('path');
const { uploadPublicAsset } = require('./publicAssetUpload');

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

async function uploadSignatureImage(buffer, originalname, clientID, req, mimetype = '') {
  const ext = safeSignatureExt(originalname, mimetype);
  const safeId = String(clientID || 'client').replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `${safeId}-${Date.now()}${ext}`;
  const repoPath = `public/uploads/signatures/${fileName}`;
  return uploadPublicAsset(buffer, repoPath, req);
}

module.exports = {
  uploadSignatureImage,
};
