const path = require('path');
const {
  uploadPublicAsset,
  unlinkLocalAssetByUrl,
  publicPathUrl,
  isRemoteAssetUrl,
} = require('./publicAssetUpload');

const FILE_TYPE_MAP = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpg',
};

function assertSupportedImage(file) {
  const mime = file.mimetype || '';
  if (!FILE_TYPE_MAP[mime]) {
    throw new Error('Invalid file type. Use JPEG or PNG.');
  }
  if (!file.buffer || !file.buffer.length) {
    throw new Error('No image data received');
  }
  return FILE_TYPE_MAP[mime];
}

function buildFileName(ext) {
  return `${Date.now()}-${Math.random().toString(36).substring(2)}.${ext}`;
}

async function storeImageBuffer(buffer, fileName, req) {
  const uploaded = await uploadPublicAsset(buffer, `public/uploads/${fileName}`, req);
  return uploaded.url;
}

/**
 * Upload one voting image the same way as products: memory buffer → GitHub public/uploads/.
 */
async function processVotingImageFile(file, req) {
  const ext = assertSupportedImage(file);
  const fileName = buildFileName(ext);
  const url = await storeImageBuffer(file.buffer, fileName, req);

  return {
    url,
    thumbnail: url,
    original: url,
    filename: fileName,
    width: 0,
    height: 0,
    format: ext,
    size: file.size,
  };
}

/** Remove local copies only (GitHub assets are not deleted here). */
function unlinkLocalVotingImageByUrl(imageUrl) {
  unlinkLocalAssetByUrl(imageUrl);
}

/** Prefix legacy relative paths when reading old records. */
function resolveLegacyVotingAssetUrl(url, req) {
  if (url == null || url === '') return url;
  const s = String(url).trim();
  if (!s || isRemoteAssetUrl(s)) return s;
  return publicPathUrl(s, req);
}

module.exports = {
  processVotingImageFile,
  unlinkLocalVotingImageByUrl,
  resolveLegacyVotingAssetUrl,
  FILE_TYPE_MAP,
};
