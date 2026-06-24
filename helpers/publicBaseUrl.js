/**
 * Public origin for links embedded in emails (unsubscribe, open tracking, signature image URLs).
 * Prefer BASE_URL on Render; RENDER_EXTERNAL_URL is set automatically by Render.
 */
function resolvePublicBaseUrl() {
  const apiPath = (process.env.API_URL || '/api/v1').replace(/\/$/, '');

  let base = (
    process.env.BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    ''
  )
    .trim()
    .replace(/\/$/, '');

  if (base && apiPath && base.endsWith(apiPath)) {
    base = base.slice(0, -apiPath.length).replace(/\/$/, '');
  }

  if (base) return base;

  if (process.env.NODE_ENV !== 'production' && !process.env.RENDER && !process.env.RENDER_SERVICE_ID) {
    return 'http://localhost:3000';
  }

  console.warn(
    '[resolvePublicBaseUrl] BASE_URL is not set. Email unsubscribe and tracking links will not work. ' +
      'Set BASE_URL=https://khanaconnect.onrender.com on Render (no trailing slash).'
  );
  return 'http://localhost:3000';
}

function resolveApiBasePath() {
  return process.env.API_URL || '/api/v1';
}

/** Full URL to a public API route, e.g. /email/newsletter/unsubscribe */
function buildPublicApiUrl(routePath, query = '') {
  const base = resolvePublicBaseUrl();
  const api = resolveApiBasePath().replace(/\/$/, '');
  const path = routePath.startsWith('/') ? routePath : `/${routePath}`;
  const qs = query ? (query.startsWith('?') ? query : `?${query}`) : '';
  return `${base}${api}${path}${qs}`;
}

module.exports = {
  resolvePublicBaseUrl,
  resolveApiBasePath,
  buildPublicApiUrl,
};
