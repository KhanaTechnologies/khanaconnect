import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage, type StorefrontOrder } from '../api/client';
import { lastCheckout } from '../api/payfast';
import { useCart } from '../cart/CartContext';
import { ErrorBox, Loading } from '../components/Status';
import { money } from '../format';
import { BookingSummary, lastBooking } from './bookingStore';

/**
 * PayFast sends shoppers back to the client's return_url / cancel_url (set on the client record
 * in the dashboard): point them at /checkout/success and /checkout/cancel on this site.
 */
function OrderResult({ id }: { id: string }) {
  const cart = useCart();
  const [order, setOrder] = useState<StorefrontOrder | null>(null);
  const [error, setError] = useState('');
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let live = true;
    api('getOrder', { path: { id } }).then(
      ({ order: o }) => {
        if (!live) return;
        setOrder(o);
        if (o.paid) cart.clear();
      },
      (err: unknown) => live && setError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, tries]);

  // PayFast's payment notification (ITN) can land a few seconds after the shopper returns.
  useEffect(() => {
    if (order && !order.paid && tries < 10) {
      const t = setTimeout(() => setTries((n) => n + 1), 3000);
      return () => clearTimeout(t);
    }
  }, [order, tries]);

  if (error) return <ErrorBox message={error} />;
  if (!order) return <Loading label="Checking your payment…" />;

  return (
    <>
      <h1>{order.paid ? 'Thank you, payment received' : 'Waiting for payment confirmation'}</h1>
      <p>
        Order <strong>{order.orderNumber}</strong>
        {order.paid
          ? ' is confirmed. We have sent a confirmation to your email and WhatsApp.'
          : tries >= 10
            ? ' is saved. PayFast has not confirmed the payment yet; you will get a confirmation as soon as it does.'
            : '. This usually takes a few seconds…'}
      </p>
      <ul className="mini-lines card">
        {order.items.map((i, n) => (
          <li key={n}>
            <span>
              {i.quantity} × {i.name}
              {i.variant ? ` (${i.variant})` : ''}
            </span>
            <span>{money(i.lineTotal)}</span>
          </li>
        ))}
        <li>
          <span>Delivery: {order.deliveryType}</span>
          <span>{money(order.deliveryPrice)}</span>
        </li>
        <li>
          <strong>Total</strong>
          <strong>{money(order.total)}</strong>
        </li>
      </ul>
      <Link to="/">Back to home</Link>
    </>
  );
}

export function CheckoutSuccess() {
  const [params] = useSearchParams();
  const last = lastCheckout();
  const orderId = params.get('order') || (last?.kind === 'order' ? last.id : '');
  const bookingId = params.get('booking') || (last?.kind === 'booking' ? last.id : '');

  if (orderId && !params.get('booking')) return <OrderResult id={orderId} />;
  const booking = lastBooking();
  if (bookingId && booking && booking.id === bookingId) {
    return (
      <>
        <h1>Deposit paid, thank you</h1>
        <p>Your booking is being confirmed. You will get a confirmation on email and WhatsApp.</p>
        <BookingSummary booking={booking} />
      </>
    );
  }
  return (
    <>
      <h1>Thank you</h1>
      <p>Your payment is being processed. You will get a confirmation shortly.</p>
    </>
  );
}

export function CheckoutCancel() {
  const last = lastCheckout();
  return (
    <>
      <h1>Payment cancelled</h1>
      <p>No money was taken.</p>
      {last?.kind === 'booking' ? (
        <Link className="btn" to="/services">
          Back to bookings
        </Link>
      ) : (
        <Link className="btn" to="/cart">
          Back to your cart
        </Link>
      )}
    </>
  );
}
