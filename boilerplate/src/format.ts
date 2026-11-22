const zar = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' });
export const money = (n: number) => zar.format(n);

/** yyyy-mm-dd in the visitor's local time (the API treats booking dates as calendar days). */
export function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function prettyDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' });
}
