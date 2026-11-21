import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, errorMessage, type StorefrontOrder } from '../api/client';
import { redirectToPayfast, rememberCheckout } from '../api/payfast';
import { useCart } from '../cart/CartContext';
import { ErrorBox } from '../components/Status';
import { money } from '../format';
import { useSite } from '../SiteContext';

export default function Checkout() {
  const cart = useCart();
  const { site } = useSite();
  const navigate = useNavigate();
  const options = site.deliveryOptions.length ? site.deliveryOptions : [{ type: 'collection', price: 0 }];
  const [deliveryType, setDeliveryType] = useState(options[0].type);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unpaid, setUnpaid] = useState<StorefrontOrder | null>(null);

  const delivery = options.find((o) => o.type === deliveryType) ?? options[0];
  const isCollection = /collect/i.test(delivery.type);

  if (!cart.lines.length && !unpaid) {
    return (
      <>
        <h1>Checkout</h1>
        <p className="muted">Your cart is empty.</p>
        <Link to="/shop">Back to the shop</Link>
      </>
    );
  }

  if (unpaid) {
    return (
      <>
        <h1>Order received</h1>
        <p>
          Your order <strong>{unpaid.orderNumber}</strong> ({money(unpaid.total)}) is saved, but online payment isn't
          available right now. {site.companyName} will contact you to arrange payment.
        </p>
      </>
    );
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) || '').trim();
    setBusy(true);
    setError('');
    try {
      const { order } = await api('createOrder', {
        body: {
          customer: { firstName: v('firstName'), lastName: v('lastName'), email: v('email'), phone: v('phone') },
          shipping: isCollection
            ? {}
            : { address: v('address'), city: v('city'), province: v('province'), postalCode: v('postalCode'), country: 'ZA' },
          deliveryType: delivery.type,
          items: cart.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, ...(l.variant ? { variant: l.variant } : {}) })),
          notes: v('notes') || undefined,
        },
      });
      rememberCheckout({ kind: 'order', id: order.id });
      try {
        const checkout = await api('payfastOrderCheckout', {
          body: {
            orderId: order.id,
            buyer: { name_first: v('firstName'), name_last: v('lastName'), email_address: v('email'), cell_number: v('phone') },
          },
        });
        redirectToPayfast(checkout);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'ALREADY_PAID') return navigate(`/checkout/success?order=${order.id}`);
        if (err instanceof ApiError && err.code === 'PAYFAST_NOT_CONFIGURED') {
          cart.clear();
          return setUnpaid(order);
        }
        throw err;
      }
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="checkout">
      <form className="form" onSubmit={submit}>
        <h1>Checkout</h1>
        <fieldset>
          <legend>Your details</legend>
          <div className="row">
            <label className="field">
              First name
              <input name="firstName" required autoComplete="given-name" />
            </label>
            <label className="field">
              Last name
              <input name="lastName" required autoComplete="family-name" />
            </label>
          </div>
          <label className="field">
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label className="field">
            Cellphone
            <input name="phone" type="tel" required autoComplete="tel" placeholder="082 123 4567" />
          </label>
        </fieldset>

        <fieldset>
          <legend>Delivery</legend>
          {options.map((o) => (
            <label key={o.type} className="radio">
              <input type="radio" name="deliveryType" checked={o.type === delivery.type} onChange={() => setDeliveryType(o.type)} />
              {o.type} · {o.price ? money(o.price) : 'free'}
            </label>
          ))}
          {!isCollection && (
            <>
              <label className="field">
                Street address
                <input name="address" required autoComplete="street-address" />
              </label>
              <div className="row">
                <label className="field">
                  City
                  <input name="city" autoComplete="address-level2" />
                </label>
                <label className="field">
                  Province
                  <input name="province" autoComplete="address-level1" />
                </label>
                <label className="field">
                  Postal code
                  <input name="postalCode" required autoComplete="postal-code" />
                </label>
              </div>
            </>
          )}
          <label className="field">
            Notes (optional)
            <textarea name="notes" rows={2} />
          </label>
        </fieldset>

        {error && <ErrorBox message={error} />}
        <button className="btn btn--block" disabled={busy}>
          {busy ? 'Taking you to PayFast…' : `Pay ${money(cart.subtotal + delivery.price)} with PayFast`}
        </button>
        <p className="muted small">You'll pay securely on PayFast and come back here.</p>
      </form>

      <aside className="card summary-card">
        <h2>Order summary</h2>
        <ul className="mini-lines">
          {cart.lines.map((l) => (
            <li key={cart.keyOf(l)}>
              <span>
                {l.quantity} × {l.name}
                {l.variant ? ` (${l.variant.value})` : ''}
              </span>
              <span>{money(l.unitPrice * l.quantity)}</span>
            </li>
          ))}
          <li>
            <span>Delivery: {delivery.type}</span>
            <span>{money(delivery.price)}</span>
          </li>
        </ul>
        <div className="summary">
          <span>Total</span>
          <strong>{money(cart.subtotal + delivery.price)}</strong>
        </div>
        <p className="muted small">Final prices are confirmed by the shop when you pay.</p>
      </aside>
    </div>
  );
}
