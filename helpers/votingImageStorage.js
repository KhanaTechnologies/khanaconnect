const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { githubUploadConfigured, uploadBufferToGitHub } = require('./githubUpload');

const VOTING_GITHUB_PREFIX = 'public/uploads/voting/items';
const VOTING_PUBLIC_DIR = path.join(__dirname, '..', 'public', 'uploads', 'voting', 'items');
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

async function storeProcessedVariant(buffer, fileName, req) {
  if (githubUploadConfigured()) {
    return uploadBufferToGitHub(buffer, `${VOTING_GITHUB_PREFIX}/${fileName}`);
  }

  fs.mkdirSync(VOTING_PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(path.join(VOTING_PUBLIC_DIR, fileName), buffer);
  return publicPathUrl(`/public/uploads/voting/items/${fileName}`, req);
}

/**
 * Process an uploaded temp file into thumb/medium/orig variants.
 * Stores like product images: full https URL on GitHub when configured,
 * otherwise full URL to /public/uploads/voting/items/ on this host.
 */
async function processVotingImageFile(file, req) {
  const filePath = file.path;
  const fileName = file.filename;
  const jpgBase = fileName.replace(/\.[^/.]+$/, '.jpg');

  const metadata = await sharp(filePath).metadata();

  const [thumbBuf, mediumBuf, origBuf] = await Promise.all([
    sharp(filePath)
      .resize(300, 300, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 80 })
      .toBuffer(),
    sharp(filePath)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer(),
    sharp(filePath).jpeg({ quality: 90 }).toBuffer(),
  ]);

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  const [thumbnail, url, original] = await Promise.all([
    storeProcessedVariant(thumbBuf, `thumb-${jpgBase}`, req),
    storeProcessedVariant(mediumBuf, `medium-${jpgBase}`, req),
    storeProcessedVariant(origBuf, `orig-${jpgBase}`, req),
  ]);

  return {
    url,
    thumbnail,
    original,
    filename: fileName,
    width: metadata.width,
    height: metadata.height,
    format: 'jpeg',
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
  for (const dir of [VOTING_PUBLIC_DIR, VOTING_LEGACY_DIR]) {
    const medium = path.join(dir, base);
    if (fs.existsSync(medium)) fs.unlinkSync(medium);
    const thumb = path.join(dir, base.replace(/^medium-/, 'thumb-'));
    if (fs.existsSync(thumb)) fs.unlinkSync(thumb);
    const orig = path.join(dir, base.replace(/^medium-/, 'orig-'));
    if (fs.existsSync(orig)) fs.unlinkSync(orig);
  }
}

/** Prefix legacy relative /uploads/... paths when reading old records (no env var). */
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
};
