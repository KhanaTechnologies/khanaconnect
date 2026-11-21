import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api/client';
import { redirectToPayfast, rememberCheckout } from '../api/payfast';
import { config } from '../config';
import { ErrorBox, Loading } from '../components/Status';
import { isoDay, money } from '../format';
import { useAsync } from '../useAsync';
import { BookingSummary, lastBooking, saveBooking, type BookingRecord } from './bookingStore';

function nextDays(n: number): Date[] {
  const today = new Date();
  return Array.from({ length: n }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + i));
}

export default function Book() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const services = useAsync(() => api('listServices'), []);
  const serviceId = params.get('service') || '';
  const service = services.data?.services.find((s) => s._id === serviceId);
  const days = useMemo(() => nextDays(Math.max(1, config.bookings.daysAhead)), []);
  const [date, setDate] = useState(isoDay(days[0]));
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const slots = useAsync(
    () =>
      service
        ? api('getAvailability', { query: { date, serviceName: service.name, duration: service.duration } })
        : Promise.resolve(null),
    [service?._id, date],
  );

  const deposit = service ? Math.round(service.price * config.bookings.depositPercent) / 100 : 0;

  if (services.loading) return <Loading />;
  if (!services.data) return <ErrorBox message={services.error || 'Services could not load'} />;

  if (!service) {
    return (
      <>
        <h1>Choose a service</h1>
        <div className="grid grid--3">
          {services.data.services.map((s) => (
            <button key={s._id} className="card service-card" onClick={() => setParams({ service: s._id })}>
              <h3>{s.name}</h3>
              <p className="muted">
                {s.duration} min · {money(s.price)}
              </p>
            </button>
          ))}
        </div>
      </>
    );
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!service || !time) return;
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) || '').trim();
    setBusy(true);
    setError('');
    try {
      const res = await api('createBooking', {
        body: {
          customerName: v('name'),
          customerEmail: v('email'),
          customerPhone: v('phone'),
          services: [service.name],
          date,
          time,
          duration: service.duration,
          notes: v('notes') || undefined,
          ...(deposit > 0 ? { depositAmount: deposit } : {}),
        },
      });
      const record: BookingRecord = {
        id: res.booking._id,
        service: service.name,
        date,
        time: res.booking.time,
        endTime: res.booking.endTime,
        status: res.booking.status,
        deposit: res.depositRequired ? deposit : 0,
        name: v('name'),
      };
      saveBooking(record);
      if (!res.depositRequired) return navigate('/booking/confirmed');

      rememberCheckout({ kind: 'booking', id: record.id });
      try {
        redirectToPayfast(await api('payfastBookingCheckout', { body: { bookingId: record.id } }));
      } catch (err) {
        if (err instanceof ApiError && err.code === 'PAYFAST_NOT_CONFIGURED') return navigate('/booking/confirmed');
        throw err;
      }
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      if (err instanceof ApiError && err.status === 409) setTime('');
    }
  }

  return (
    <div className="book">
      <p className="muted">
        <Link to="/services">Services</Link> / {service.name}
      </p>
      <h1>{service.name}</h1>
      <p className="muted">
        {service.duration} min · {money(service.price)}
        {deposit > 0 && ` · ${money(deposit)} deposit to book`}
      </p>

      <h2>Pick a day</h2>
      <div className="days" role="listbox" aria-label="Day">
        {days.map((d) => {
          const iso = isoDay(d);
          return (
            <button
              key={iso}
              role="option"
              aria-selected={iso === date}
              className={iso === date ? 'day is-active' : 'day'}
              onClick={() => {
                setDate(iso);
                setTime('');
              }}
            >
              <span>{d.toLocaleDateString('en-ZA', { weekday: 'short' })}</span>
              <strong>{d.getDate()}</strong>
              <span>{d.toLocaleDateString('en-ZA', { month: 'short' })}</span>
            </button>
          );
        })}
      </div>

      <h2>Pick a time</h2>
      {slots.loading && <Loading label="Finding open times…" />}
      {slots.error && <ErrorBox message={slots.error} />}
      {slots.data && !slots.data.availableSlots.length && <p className="muted">No open times on this day. Try another day.</p>}
      <div className="slots">
        {slots.data?.availableSlots.map((s) => (
          <button key={s.time} className={s.time === time ? 'slot is-active' : 'slot'} onClick={() => setTime(s.time)}>
            {s.time}
          </button>
        ))}
      </div>

      {time && (
        <form className="form" onSubmit={submit}>
          <h2>Your details</h2>
          <label className="field">
            Full name
            <input name="name" required autoComplete="name" />
          </label>
          <div className="row">
            <label className="field">
              Email
              <input name="email" type="email" required autoComplete="email" />
            </label>
            <label className="field">
              Cellphone
              <input name="phone" type="tel" required autoComplete="tel" />
            </label>
          </div>
          <label className="field">
            Notes (optional)
            <textarea name="notes" rows={2} />
          </label>
          {error && <ErrorBox message={error} />}
          <button className="btn btn--block" disabled={busy}>
            {busy ? 'Booking…' : deposit > 0 ? `Book ${time} and pay ${money(deposit)} deposit` : `Book ${time}`}
          </button>
        </form>
      )}
    </div>
  );
}

export function BookingConfirmed() {
  const booking = lastBooking();
  if (!booking) {
    return (
      <>
        <h1>Booking</h1>
        <Link to="/services">Make a booking</Link>
      </>
    );
  }
  return (
    <>
      <h1>{booking.status === 'confirmed' ? 'You’re booked!' : 'Booking received'}</h1>
      <p>
        {booking.status === 'confirmed'
          ? 'We look forward to seeing you. A confirmation is on its way to your email and WhatsApp.'
          : 'We will confirm your booking shortly.'}
      </p>
      <BookingSummary booking={booking} />
      <Link to="/">Back to home</Link>
    </>
  );
}
