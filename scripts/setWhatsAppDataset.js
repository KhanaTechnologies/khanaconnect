/**
 * @deprecated Prefer scripts/rebindWhatsAppDatasets.js — messaging conversions
 * must use each client's WABA dataset, not a shared website Pixel.
 *
 * This script is kept only for emergency ops and will refuse known website Pixel IDs.
 */
require('dotenv').config();

const FORBIDDEN = new Set(
  String(process.env.KHANA_WEBSITE_PIXEL_ID || '1063249069528132')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const datasetId = String(process.argv[2] || '').trim();
if (!datasetId) {
  console.error('Deprecated. Use: node scripts/rebindWhatsAppDatasets.js');
  process.exit(1);
}
if (FORBIDDEN.has(datasetId)) {
  console.error(
    `Refusing to set shared website Pixel ${datasetId} on WhatsApp accounts. Use scripts/rebindWhatsAppDatasets.js`
  );
  process.exit(1);
}
console.error('Manual shared dataset assignment is disabled. Use scripts/rebindWhatsAppDatasets.js');
process.exit(1);
