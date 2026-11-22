import { useEffect, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { config, hasBookings, hasStore } from '../config';
import { useCart } from '../cart/CartContext';
import { useSite } from '../SiteContext';
import { ErrorBox } from './Status';

function CartLink() {
  const { count } = useCart();
  return (
    <NavLink to="/cart" className="nav__cart" aria-label={`Cart, ${count} items`}>
      Cart{count > 0 && <span className="badge">{count}</span>}
    </NavLink>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { site, error } = useSite();
  useEffect(() => {
    document.title = `${site.companyName} · ${config.tagline}`;
  }, [site.companyName]);

  return (
    <div className="shell">
      <header className="header">
        <div className="container header__inner">
          <Link to="/" className="brand">
            {config.theme.logoUrl ? <img src={config.theme.logoUrl} alt={site.companyName} /> : site.companyName}
          </Link>
          <nav className="nav">
            {hasStore && <NavLink to="/shop">Shop</NavLink>}
            {hasBookings && <NavLink to="/services">Book</NavLink>}
            <NavLink to="/contact">Contact</NavLink>
            {hasStore && <CartLink />}
          </nav>
        </div>
      </header>
      <main className="container main">
        {error && <ErrorBox message={`Shop settings could not load: ${error}`} />}
        {children}
      </main>
      <footer className="footer">
        <div className="container footer__inner">
          <span>
            © {new Date().getFullYear()} {site.companyName}
          </span>
          {site.whatsappChatUrl && (
            <a className="btn btn--ghost" href={site.whatsappChatUrl} target="_blank" rel="noreferrer">
              Chat on WhatsApp
            </a>
          )}
        </div>
      </footer>
    </div>
  );
}
