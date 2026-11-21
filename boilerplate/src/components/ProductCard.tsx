import { Link } from 'react-router-dom';
import type { StorefrontProduct } from '../api/client';
import { money } from '../format';

export function Price({ product }: { product: StorefrontProduct }) {
  return (
    <span className="price">
      {money(product.unitPrice)}
      {product.salePercentage > 0 && <s className="price__was">{money(product.price)}</s>}
    </span>
  );
}

export function ProductCard({ product }: { product: StorefrontProduct }) {
  return (
    <Link to={`/shop/${product.slug || product.id}`} className="card product-card">
      <div className="product-card__img">
        {product.images[0] ? <img src={product.images[0]} alt="" loading="lazy" /> : <span>{product.name.slice(0, 1)}</span>}
        {!product.inStock && <span className="tag">Sold out</span>}
      </div>
      <div className="product-card__body">
        <h3>{product.name}</h3>
        <Price product={product} />
      </div>
    </Link>
  );
}
