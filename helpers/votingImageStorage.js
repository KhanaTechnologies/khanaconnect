const fs = require('fs');
const path = require('path');
const { githubUploadConfigured, uploadBufferToGitHub } = require('./githubUpload');

const FILE_TYPE_MAP = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpg',
};

const PUBLIC_UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');
const VOTING_LEGACY_DIR = path.join(__dirname, '..', 'uploads', 'voting', 'items');

function requestOrigin(req) {
  if (!req || typeof req.get !== 'function') return '';
  const host = req.get('host');
  if (!host) return '';
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${host}`.replace(/\/$/, '');
}

function publicPathUrl(relativePath, req) {
  const rel = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  const origin = requestOrigin(req);
  return origin ? `${origin}${rel}` : rel;
}

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
  const repoPath = `public/uploads/${fileName}`;

  if (githubUploadConfigured()) {
    return uploadBufferToGitHub(buffer, repoPath);
  }

  fs.mkdirSync(PUBLIC_UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PUBLIC_UPLOADS_DIR, fileName), buffer);
  return publicPathUrl(`/public/uploads/${fileName}`, req);
}

/**
 * Upload one voting image the same way as products: memory buffer → public/uploads/ on GitHub.
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

function isRemoteAssetUrl(imageUrl) {
  return typeof imageUrl === 'string' && /^https?:\/\//i.test(imageUrl.trim());
}

/** Remove local copies only (GitHub assets are not deleted here). */
function unlinkLocalVotingImageByUrl(imageUrl) {
  if (!imageUrl || isRemoteAssetUrl(imageUrl)) return;
  const base = path.basename(String(imageUrl));
  for (const dir of [PUBLIC_UPLOADS_DIR, VOTING_LEGACY_DIR]) {
    const filePath = path.join(dir, base);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
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
  requestOrigin,
  FILE_TYPE_MAP,
};
