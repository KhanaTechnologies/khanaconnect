import { Link } from 'react-router-dom';
import { useCart } from '../cart/CartContext';
import { money } from '../format';

export default function Cart() {
  const cart = useCart();
  if (!cart.lines.length) {
    return (
      <>
        <h1>Your cart</h1>
        <p className="muted">Your cart is empty.</p>
        <Link className="btn" to="/shop">
          Browse the shop
        </Link>
      </>
    );
  }
  return (
    <>
      <h1>Your cart</h1>
      <ul className="lines">
        {cart.lines.map((l) => {
          const key = cart.keyOf(l);
          return (
            <li key={key} className="line">
              {l.image ? <img src={l.image} alt="" /> : <span className="line__img" />}
              <div className="line__name">
                <strong>{l.name}</strong>
                {l.variant && (
                  <span className="muted">
                    {l.variant.name}: {l.variant.value}
                  </span>
                )}
              </div>
              <input
                type="number"
                min={1}
                max={99}
                value={l.quantity}
                onChange={(e) => cart.setQuantity(key, Number(e.target.value) || 1)}
                aria-label={`Quantity of ${l.name}`}
              />
              <span>{money(l.unitPrice * l.quantity)}</span>
              <button className="link" onClick={() => cart.remove(key)}>
                Remove
              </button>
            </li>
          );
        })}
      </ul>
      <div className="summary">
        <span>Subtotal</span>
        <strong>{money(cart.subtotal)}</strong>
      </div>
      <p className="muted">Delivery is added at checkout.</p>
      <Link className="btn" to="/checkout">
        Checkout
      </Link>
    </>
  );
}
