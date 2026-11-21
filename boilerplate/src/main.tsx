import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { config, hasBookings, hasStore } from './config';
import { applyTheme } from './theme';
import { CartProvider } from './cart/CartContext';
import { SiteProvider } from './SiteContext';
import { Layout } from './components/Layout';
import Home from './pages/Home';
import Shop from './pages/Shop';
import Product from './pages/Product';
import Cart from './pages/Cart';
import Checkout from './pages/Checkout';
import { CheckoutCancel, CheckoutSuccess } from './pages/CheckoutResult';
import Services from './pages/Services';
import Book, { BookingConfirmed } from './pages/Book';
import Contact from './pages/Contact';
import './styles.css';

applyTheme(config.theme);

function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <Link to="/">Go home</Link>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SiteProvider>
        <CartProvider>
          <Layout>
            <Routes>
              <Route path="/" element={<Home />} />
              {hasStore && (
                <>
                  <Route path="/shop" element={<Shop />} />
                  <Route path="/shop/:idOrSlug" element={<Product />} />
                  <Route path="/cart" element={<Cart />} />
                  <Route path="/checkout" element={<Checkout />} />
                </>
              )}
              {hasBookings && (
                <>
                  <Route path="/services" element={<Services />} />
                  <Route path="/book" element={<Book />} />
                  <Route path="/booking/confirmed" element={<BookingConfirmed />} />
                </>
              )}
              {/* PayFast return_url / cancel_url (both store orders and booking deposits) */}
              <Route path="/checkout/success" element={<CheckoutSuccess />} />
              <Route path="/checkout/cancel" element={<CheckoutCancel />} />
              <Route path="/contact" element={<Contact />} />
              <Route path="/home" element={<Navigate to="/" replace />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Layout>
        </CartProvider>
      </SiteProvider>
    </BrowserRouter>
  </StrictMode>,
);
