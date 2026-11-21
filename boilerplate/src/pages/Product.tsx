import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useCart } from '../cart/CartContext';
import { Price } from '../components/ProductCard';
import { ErrorBox, Loading } from '../components/Status';
import { money } from '../format';
import { useAsync } from '../useAsync';

export default function Product() {
  const { idOrSlug = '' } = useParams();
  const state = useAsync(() => api('getProduct', { path: { idOrSlug } }), [idOrSlug]);
  const cart = useCart();
  const [choice, setChoice] = useState('');
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  const [image, setImage] = useState(0);

  if (state.loading) return <Loading />;
  if (!state.data) return <ErrorBox message={state.error || 'Product not found'} />;
  const p = state.data.product;

  // The API prices one variant name/value per order line, so the first variant group is offered.
  const group = p.variants[0];
  const picked = group?.values.find((v) => v.value === choice);
  const available = group ? !!picked?.inStock : p.inStock;

  let label = 'Add to cart';
  if (group && !picked) label = `Choose ${group.name.toLowerCase()}`;
  else if (!available) label = 'Sold out';

  return (
    <div className="product">
      <div className="product__gallery">
        {p.images[image] ? (
          <img src={p.images[image]} alt={p.name} />
        ) : (
          <div className="product__placeholder">{p.name.slice(0, 1)}</div>
        )}
        {p.images.length > 1 && (
          <div className="thumbs">
            {p.images.map((src, i) => (
              <button key={src} onClick={() => setImage(i)} aria-label={`Image ${i + 1}`} className={i === image ? 'is-active' : ''}>
                <img src={src} alt="" />
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="product__info">
        <p className="muted">
          <Link to="/shop">Shop</Link>
          {p.category && <> / {p.category.name}</>}
        </p>
        <h1>{p.name}</h1>
        {picked ? <span className="price">{money(picked.unitPrice)}</span> : <Price product={p} />}
        <p>{p.description}</p>

        {group && (
          <label className="field">
            {group.name}
            <select value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">Choose {group.name.toLowerCase()}</option>
              {group.values.map((v) => (
                <option key={v.value} value={v.value} disabled={!v.inStock}>
                  {v.value} · {money(v.unitPrice)}
                  {v.inStock ? '' : ' (sold out)'}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="buy">
          <input
            type="number"
            min={1}
            max={99}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
            aria-label="Quantity"
          />
          <button
            className="btn"
            disabled={!available}
            onClick={() => {
              cart.add(p, qty, group && picked ? { name: group.name, value: picked.value } : undefined);
              setAdded(true);
            }}
          >
            {label}
          </button>
        </div>
        {added && (
          <p className="notice">
            Added. <Link to="/cart">View cart →</Link>
          </p>
        )}
        {/* richDescription is written by the business owner in the dashboard editor. */}
        {p.richDescription && <div className="rich" dangerouslySetInnerHTML={{ __html: p.richDescription }} />}
      </div>
    </div>
  );
}
