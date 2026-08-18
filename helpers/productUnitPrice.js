/**
 * Server-side unit price from the catalog. Never trust client-sent variantPrice.
 */
function catalogUnitPrice(product, variantName = '', variantValue = '') {
  let price = Number(product?.price) || 0;
  const name = String(variantName || '').trim();
  const value = String(variantValue || '').trim();

  if (name && Array.isArray(product?.variants)) {
    const option = product.variants.find((v) => String(v.name || '') === name);
    const match = option?.values?.find((v) => String(v.value || '') === value);
    if (match && Number(match.price) > 0) {
      price = Number(match.price);
    }
  }

  const pct = Number(product?.salePercentage) || 0;
  if (pct > 0 && pct <= 100) {
    price = price * (1 - pct / 100);
  }

  return Math.max(0, Math.round(price * 100) / 100);
}

function parseVariantFields(raw) {
  if (!raw) return { name: '', value: '' };
  if (typeof raw === 'string') {
    return { name: '', value: raw.trim() };
  }
  return {
    name: String(raw.name || raw.variantName || '').trim(),
    value: String(raw.value || raw.variantValue || raw.label || '').trim(),
  };
}

module.exports = { catalogUnitPrice, parseVariantFields };
