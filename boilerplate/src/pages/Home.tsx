import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { config, hasBookings, hasStore } from '../config';
import { ProductCard } from '../components/ProductCard';
import { useAsync } from '../useAsync';
import { money } from '../format';

function Featured() {
  const state = useAsync(() => api('listProducts', { query: { featured: 'true' } }), []);
  const products = state.data?.products.slice(0, 4) ?? [];
  if (!products.length) return null;
  return (
    <section className="section">
      <div className="section__head">
        <h2>Featured</h2>
        <Link to="/shop">See everything →</Link>
      </div>
      <div className="grid">
        {products.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>
    </section>
  );
}

function PopularServices() {
  const state = useAsync(() => api('listServices'), []);
  const services = state.data?.services.slice(0, 3) ?? [];
  if (!services.length) return null;
  return (
    <section className="section">
      <div className="section__head">
        <h2>Book a session</h2>
        <Link to="/services">All services →</Link>
      </div>
      <div className="grid grid--3">
        {services.map((s) => (
          <Link key={s._id} to={`/book?service=${encodeURIComponent(s._id)}`} className="card service-card">
            <h3>{s.name}</h3>
            <p className="muted">
              {s.duration} min · {money(s.price)}
            </p>
          </Link>
        ))}
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <>
      <section className="hero" style={config.hero.imageUrl ? { backgroundImage: `url(${config.hero.imageUrl})` } : undefined}>
        <h1>{config.hero.title}</h1>
        <p>{config.hero.subtitle}</p>
        <div className="hero__actions">
          {hasStore && (
            <Link className="btn" to="/shop">
              Shop now
            </Link>
          )}
          {hasBookings && (
            <Link className={hasStore ? 'btn btn--ghost' : 'btn'} to="/services">
              Book now
            </Link>
          )}
        </div>
      </section>
      {hasStore && <Featured />}
      {hasBookings && <PopularServices />}
    </>
  );
}
