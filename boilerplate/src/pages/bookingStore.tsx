import { money, prettyDay } from '../format';

/** The last booking made in this browser (there is no public GET for bookings). */
export interface BookingRecord {
  id: string;
  service: string;
  date: string; // yyyy-mm-dd
  time: string;
  endTime: string;
  status: string;
  deposit: number;
  name: string;
}

const KEY = 'khana:lastBooking';

export function saveBooking(b: BookingRecord): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(b));
  } catch {
    /* ignore */
  }
}

export function lastBooking(): BookingRecord | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as BookingRecord) : null;
  } catch {
    return null;
  }
}

export function BookingSummary({ booking }: { booking: BookingRecord }) {
  return (
    <dl className="card details">
      <dt>Service</dt>
      <dd>{booking.service}</dd>
      <dt>When</dt>
      <dd>
        {prettyDay(booking.date)}, {booking.time}–{booking.endTime}
      </dd>
      <dt>Name</dt>
      <dd>{booking.name}</dd>
      {booking.deposit > 0 && (
        <>
          <dt>Deposit</dt>
          <dd>{money(booking.deposit)}</dd>
        </>
      )}
    </dl>
  );
}
