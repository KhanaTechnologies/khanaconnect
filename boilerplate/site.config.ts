/**
 * THE file to edit for a new client site. See README.md → "Launch a new client site".
 */
import type { SiteConfig } from './src/config';

const site: SiteConfig = {
  clientId: 'demo-client',
  apiBaseUrl: 'http://localhost:4010/api/v1',
  storefrontToken: '', // set VITE_STOREFRONT_TOKEN in .env.local instead of committing it per client
  mode: 'both', // 'store' | 'bookings' | 'both'

  name: 'Demo Studio',
  tagline: 'Beautiful things, booked and delivered.',
  hero: {
    title: 'Hand-made candles and calm treatments',
    subtitle: 'Shop online, or book a session in Pretoria. Confirmations come straight to your WhatsApp.',
  },
  contact: {
    email: 'hello@example.com',
    phone: '012 345 6789',
    address: 'Pretoria, South Africa',
    showForm: true,
  },
  bookings: {
    depositPercent: 0,
    daysAhead: 30,
  },
  theme: {
    colors: {
      primary: '#1f6f5c',
      primaryText: '#ffffff',
      background: '#f7f5f0',
      surface: '#ffffff',
      text: '#1d1d1b',
      muted: '#6b6b66',
      border: '#e4e0d6',
    },
    fonts: {
      heading: "'Fraunces', Georgia, serif",
      body: "'Inter', system-ui, sans-serif",
      googleFontsUrl:
        'https://fonts.googleapis.com/css2?family=Fraunces:wght@600&family=Inter:wght@400;500;600&display=swap',
    },
    radius: '12px',
  },
};

export default site;
