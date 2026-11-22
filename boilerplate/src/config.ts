/**
 * Site config types. Each client site fills in ../site.config.ts; nothing else should need
 * editing to launch a standard store / bookings site.
 *
 * `theme` is deliberately plain data (colours, fonts, radius, logo) so a skin from the
 * Khana template gallery can be dropped in as a theme object later.
 */
import site from '../site.config';

export type SiteMode = 'store' | 'bookings' | 'both';

export interface SiteTheme {
  colors: {
    primary: string;
    primaryText: string; // text on primary buttons
    background: string;
    surface: string; // cards, header
    text: string;
    muted: string;
    border: string;
  };
  fonts: {
    heading: string;
    body: string;
    /** Optional Google Fonts stylesheet URL loaded at start-up. */
    googleFontsUrl?: string;
  };
  radius: string; // e.g. '12px'
  logoUrl?: string; // falls back to the company name in text
}

export interface SiteConfig {
  /** khanaconnect clientID (for display/debug; the token is what identifies the client to the API). */
  clientId: string;
  /** API base including /api/v1. Overridden by VITE_API_BASE_URL. */
  apiBaseUrl: string;
  /** Storefront token. Overridden by VITE_STOREFRONT_TOKEN. Public by design. */
  storefrontToken: string;
  mode: SiteMode;
  /** Shown until GET /storefront/site answers, and in the <title>. */
  name: string;
  tagline: string;
  hero: { title: string; subtitle: string; imageUrl?: string };
  contact: { email?: string; phone?: string; address?: string; showForm: boolean };
  bookings: {
    /** Deposit charged through PayFast, as a % of the service price. 0 = no deposit (booking confirmed straight away). */
    depositPercent: number;
    /** How many days ahead visitors can book. */
    daysAhead: number;
  };
  theme: SiteTheme;
}

function fromEnv(key: string): string | undefined {
  const v = (import.meta.env as Record<string, string | undefined>)[key];
  return v && v.trim() ? v.trim() : undefined;
}

export const config: SiteConfig = {
  ...site,
  apiBaseUrl: (fromEnv('VITE_API_BASE_URL') || site.apiBaseUrl).replace(/\/+$/, ''),
  storefrontToken: fromEnv('VITE_STOREFRONT_TOKEN') || site.storefrontToken,
};

export const hasStore = config.mode === 'store' || config.mode === 'both';
export const hasBookings = config.mode === 'bookings' || config.mode === 'both';
