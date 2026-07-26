function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function parseOptionalNumber(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseTags(raw) {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean))].slice(0, 40);
  }
  return [
    ...new Set(
      String(raw || '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
    ),
  ].slice(0, 40);
}

function parseStatus(raw, fallback = 'published') {
  const s = String(raw || '').trim().toLowerCase();
  if (['draft', 'published', 'archived'].includes(s)) return s;
  return fallback;
}

function parseBool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return fallback;
}

/**
 * Build additive catalog fields from req.body for create/update.
 */
function pickProductCatalogFields(body = {}, existing = null) {
  const out = {};

  if (body.status !== undefined || !existing) {
    out.status = parseStatus(body.status, existing?.status || 'published');
  }

  if (body.sku !== undefined || !existing) {
    out.sku = String(body.sku || existing?.sku || '').trim().slice(0, 80);
  }

  for (const key of ['weightKg', 'lengthCm', 'widthCm', 'heightCm']) {
    if (body[key] !== undefined) {
      const n = parseOptionalNumber(body[key]);
      out[key] = n === undefined ? null : n;
    }
  }

  if (body.tags !== undefined) {
    out.tags = parseTags(body.tags) || [];
  }

  if (body.slug !== undefined || body.productName || !existing) {
    const slugRaw = body.slug !== undefined ? body.slug : existing?.slug;
    const name = body.productName || existing?.productName || '';
    out.slug = slugify(slugRaw || name);
  }

  if (body.metaTitle !== undefined) {
    out.metaTitle = String(body.metaTitle || '').trim().slice(0, 120);
  }
  if (body.metaDescription !== undefined) {
    out.metaDescription = String(body.metaDescription || '').trim().slice(0, 320);
  }

  if (body.isFeatured !== undefined) {
    out.isFeatured = parseBool(body.isFeatured, existing?.isFeatured ?? false);
  }

  if (body.collectionIds !== undefined) {
    const ids = Array.isArray(body.collectionIds)
      ? body.collectionIds
      : typeof body.collectionIds === 'string'
        ? (() => {
            try {
              return JSON.parse(body.collectionIds);
            } catch {
              return String(body.collectionIds)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            }
          })()
        : [];
    out.collectionIds = ids;
  }

  return out;
}

/**
 * Storefront / public reads: published products.
 * Existing catalog docs often have no `status` field — treat missing/null as published
 * so deploy does not hide clients' live products.
 */
function publishedProductFilter(extra = {}) {
  const { status: _ignored, ...rest } = extra || {};
  return {
    ...rest,
    $or: [{ status: 'published' }, { status: { $exists: false } }, { status: null }],
  };
}

module.exports = {
  slugify,
  parseTags,
  parseStatus,
  parseBool,
  pickProductCatalogFields,
  publishedProductFilter,
};
