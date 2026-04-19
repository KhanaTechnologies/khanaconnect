/**
 * Eligibility for sending a service wishlist reminder (on-time or catch-up after a missed run).
 */

function graceDaysAfterMonthEnd() {
  const raw = process.env.SERVICE_WISHLIST_CATCH_UP_DAYS_AFTER_MONTH;
  if (raw === undefined || raw === '') return 7;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 60) : 7;
}

/**
 * @param {{ reminderYear: number, reminderMonth: number, catchUpIfMissed?: boolean, lastReminderSentAt?: Date|null }} row
 * @param {Date} now
 */
function isReminderDueForSend(row, now = new Date()) {
  if (row.lastReminderSentAt) return false;
  if (row.catchUpIfMissed === false) {
    return (
      now.getFullYear() === row.reminderYear &&
      now.getMonth() + 1 === row.reminderMonth &&
      now.getDate() === 1
    );
  }

  const y = row.reminderYear;
  const mo = row.reminderMonth;
  const monthStart = new Date(y, mo - 1, 1, 0, 0, 0, 0);
  const monthEnd = new Date(y, mo, 0, 23, 59, 59, 999);
  const graceMs = graceDaysAfterMonthEnd() * 86400000;
  const graceEnd = new Date(monthEnd.getTime() + graceMs);
  return now >= monthStart && now <= graceEnd;
}

module.exports = {
  graceDaysAfterMonthEnd,
  isReminderDueForSend,
};
