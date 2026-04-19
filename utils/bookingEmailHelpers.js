/**
 * Plain-object diff helpers for booking update notification emails.
 */

function normDate(d) {
  if (d == null || d === '') return '';
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return String(d);
  return x.toISOString().split('T')[0];
}

function idStr(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'object' && v._id) return String(v._id);
  return String(v);
}

function servicesKey(services) {
  if (!Array.isArray(services)) return '';
  return services.map((s) => String(s).trim()).join('|');
}

/**
 * @returns {{ label: string, from: string, to: string }[]}
 */
function diffBookingForCustomer(prev, next) {
  const rows = [];
  const add = (label, a, b) => {
    const sa = a === undefined || a === null ? '' : String(a);
    const sb = b === undefined || b === null ? '' : String(b);
    if (sa !== sb) rows.push({ label, from: sa || '—', to: sb || '—' });
  };

  add('Customer name', prev.customerName, next.customerName);
  add('Customer phone', prev.customerPhone, next.customerPhone);
  add('Customer email', prev.customerEmail, next.customerEmail);
  add('Date', normDate(prev.date), normDate(next.date));
  add('Start time', prev.time, next.time);
  add('End time', prev.endTime, next.endTime);
  add('Duration (minutes)', prev.duration, next.duration);
  add('Services', servicesKey(prev.services), servicesKey(next.services));
  add('Status', prev.status, next.status);
  add('Notes', prev.notes, next.notes);
  add('Staff / assignee', idStr(prev.assignedTo), idStr(next.assignedTo));
  add('Resource', idStr(prev.resourceId), idStr(next.resourceId));

  const pa = prev.accommodation || {};
  const na = next.accommodation || {};
  if (pa.checkIn || na.checkIn) add('Check-in', normDate(pa.checkIn), normDate(na.checkIn));
  if (pa.checkOut || na.checkOut) add('Check-out', normDate(pa.checkOut), normDate(na.checkOut));
  if (pa.numberOfGuests != null || na.numberOfGuests != null) {
    add('Number of guests', pa.numberOfGuests, na.numberOfGuests);
  }
  if (pa.roomType || na.roomType) add('Room type', pa.roomType, na.roomType);

  return rows;
}

/**
 * Normalize rows from the dashboard when saving multiple booking moves with "notify customer".
 * Each item: { label, from, to } (strings). Returns [] if the array was present but empty/invalid,
 * or null if `raw` was not an array (caller should fall back to server-side diff).
 * @param {unknown} raw
 * @returns {{ label: string, from: string, to: string }[]|null}
 */
function normalizeCustomerNotifyChanges(raw) {
  if (!Array.isArray(raw)) return null;
  const rows = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const label =
      typeof item.label === 'string' ? item.label.trim() : String(item.label || '').trim();
    const from = item.from != null ? String(item.from) : '';
    const to = item.to != null ? String(item.to) : '';
    if (!label) continue;
    rows.push({
      label: label.slice(0, 200),
      from: from.slice(0, 2000),
      to: to.slice(0, 2000),
    });
  }
  return rows;
}

module.exports = {
  diffBookingForCustomer,
  normalizeCustomerNotifyChanges,
  normDate,
};
