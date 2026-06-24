const fs = require('fs');
const path = require('path');
const { githubUploadConfigured, uploadBufferToGitHub } = require('./githubUpload');

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
  const base = (process.env.BASE_URL || requestOrigin(req) || '').replace(/\/$/, '');
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

/**
 * Persist a public asset to GitHub (production) or local public/uploads (dev only).
 */
async function uploadPublicAsset(buffer, repoRelativePath, req) {
  if (!buffer || !buffer.length) {
    throw new Error('No file data received');
  }

  const repoPath = normalizeRepoPath(repoRelativePath);

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
      'GitHub upload is required on the server. Set GITHUB_TOKEN, GITHUB_REPO, and GITHUB_BRANCH.'
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

/** Delete a local copy only — remote/GitHub URLs are left unchanged. */
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
  uploadPublicAsset,
  unlinkLocalAssetByUrl,
};
