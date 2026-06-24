const HEX_COLOR_RE = /^#([0-9A-Fa-f]{6})$/;

function normalizeDashboardThemeColor(value) {
  if (value === null || value === undefined || value === '') return '';
  const raw = String(value).trim();
  if (!raw) return '';
  const withHash = raw.startsWith('#') ? raw : `#${raw}`;
  if (!HEX_COLOR_RE.test(withHash)) return null;
  return withHash.toLowerCase();
}

module.exports = {
  HEX_COLOR_RE,
  normalizeDashboardThemeColor,
};
