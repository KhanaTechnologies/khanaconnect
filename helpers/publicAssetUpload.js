const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const { githubUploadConfigured, uploadBufferToGitHub } = require('./githubUpload');
const { resolvePublicBaseUrl } = require('./publicBaseUrl');

const PROJECT_ROOT = path.join(__dirname, '..');
const PUBLIC_UPLOADS_DIR = path.join(PROJECT_ROOT, 'public', 'uploads');

function isDeployedEnvironment() {
  return (
    process.env.NODE_ENV === 'production' ||
    !!process.env.RENDER ||
    !!process.env.RENDER_SERVICE_ID ||
    process.env.REQUIRE_GITHUB_UPLOADS === 'true'
  );
}

function requestOrigin(req) {
  if (!req || typeof req.get !== 'function') return '';
  const host = req.get('host');
  if (!host) return '';
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${host}`.replace(/\/$/, '');
}

function publicPathUrl(relativePath, req) {
  const rel = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  const base = (resolvePublicBaseUrl() || requestOrigin(req) || '').replace(/\/$/, '');
  return base ? `${base}${rel}` : rel;
}

function isRemoteAssetUrl(imageUrl) {
  return typeof imageUrl === 'string' && /^https?:\/\//i.test(imageUrl.trim());
}

function normalizeRepoPath(repoRelativePath) {
  const normalized = String(repoRelativePath || '').replace(/^\/+/, '');
  if (!normalized.startsWith('public/uploads/')) {
    throw new Error('Assets must be stored under public/uploads/');
  }
  return normalized;
}

function cloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
  );
}

/**
 * Upload to Cloudinary when CLOUDINARY_* env vars are set.
 * Returns HTTPS CDN URL. Prefer this over GitHub for product/commerce images.
 */
async function uploadBufferToCloudinary(buffer, repoRelativePath) {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const folder = (process.env.CLOUDINARY_FOLDER || 'khanaconnect').replace(/^\/+|\/+$/g, '');
  const publicIdBase = path
    .basename(repoRelativePath || `asset-${Date.now()}`)
    .replace(/\.[^.]+$/, '')
    .slice(0, 120);
  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = `folder=${folder}&public_id=${publicIdBase}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash('sha1').update(paramsToSign).digest('hex');

  const form = new FormData();
  form.append('file', buffer, { filename: path.basename(repoRelativePath || 'upload.jpg') });
  form.append('api_key', apiKey);
  form.append('timestamp', String(timestamp));
  form.append('signature', signature);
  form.append('folder', folder);
  form.append('public_id', publicIdBase);

  const { data } = await axios.post(
    `https://api.cloudinary.com/v1_1/${cloud}/image/upload`,
    form,
    {
      headers: form.getHeaders(),
      timeout: 60000,
      maxContentLength: 20 * 1024 * 1024,
      maxBodyLength: 20 * 1024 * 1024,
    }
  );
  if (!data?.secure_url) {
    throw new Error('Cloudinary did not return secure_url');
  }
  return {
    url: data.secure_url,
    fileName: path.basename(repoRelativePath || data.public_id || 'asset'),
    publicPath: data.public_id || '',
    storage: 'cloudinary',
    cloudinary: {
      public_id: data.public_id,
      version: data.version,
      format: data.format,
    },
  };
}

/**
 * Persist a public asset.
 * Priority: Cloudinary (if configured) → GitHub → local disk (dev only).
 */
async function uploadPublicAsset(buffer, repoRelativePath, req) {
  if (!buffer || !buffer.length) {
    throw new Error('No file data received');
  }

  const repoPath = normalizeRepoPath(repoRelativePath);

  if (cloudinaryConfigured()) {
    try {
      return await uploadBufferToCloudinary(buffer, repoPath);
    } catch (err) {
      console.error('[uploadPublicAsset] Cloudinary failed, falling back:', err.message);
    }
  }

  if (githubUploadConfigured()) {
    const url = await uploadBufferToGitHub(buffer, repoPath);
    return {
      url,
      fileName: path.basename(repoPath),
      publicPath: `/${repoPath}`,
      storage: 'github',
    };
  }

  if (isDeployedEnvironment()) {
    throw new Error(
      'Image upload is not configured. Set CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET (recommended) or GITHUB_TOKEN/GITHUB_REPO/GITHUB_BRANCH.'
    );
  }

  const fullPath = path.join(PROJECT_ROOT, repoPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, buffer);

  return {
    url: publicPathUrl(`/${repoPath}`, req),
    fileName: path.basename(repoPath),
    publicPath: `/${repoPath}`,
    storage: 'disk',
    localPath: fullPath,
  };
}

/** Delete a local copy only — remote/GitHub/CDN URLs are left unchanged. */
function unlinkLocalAssetByUrl(imageUrl) {
  if (!imageUrl || isRemoteAssetUrl(imageUrl)) return;

  const raw = String(imageUrl).trim();
  const base = path.basename(raw.split('?')[0]);
  if (!base || base.includes('..')) return;

  const candidates = [
    path.join(PUBLIC_UPLOADS_DIR, base),
    path.join(PUBLIC_UPLOADS_DIR, 'signatures', base),
    path.join(PUBLIC_UPLOADS_DIR, 'campaigns', base),
    path.join(PUBLIC_UPLOADS_DIR, 'promotions', base),
    path.join(PUBLIC_UPLOADS_DIR, 'categories', base),
    path.join(PROJECT_ROOT, 'uploads', 'campaigns', base),
    path.join(PROJECT_ROOT, 'uploads', 'voting', 'items', base),
  ];

  if (raw.includes('/public/uploads/')) {
    const suffix = raw.split('/public/uploads/')[1];
    if (suffix && !suffix.includes('..')) {
      candidates.unshift(path.join(PUBLIC_UPLOADS_DIR, suffix.replace(/\//g, path.sep)));
    }
  }

  if (raw.includes('/uploads/campaigns/')) {
    candidates.unshift(path.join(PROJECT_ROOT, 'uploads', 'campaigns', base));
  }

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

module.exports = {
  PUBLIC_UPLOADS_DIR,
  isDeployedEnvironment,
  requestOrigin,
  publicPathUrl,
  isRemoteAssetUrl,
  cloudinaryConfigured,
  uploadPublicAsset,
  unlinkLocalAssetByUrl,
};
