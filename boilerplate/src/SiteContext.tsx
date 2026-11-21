import { createContext, useContext, type ReactNode } from 'react';
import { api, type StorefrontSite } from './api/client';
import { config } from './config';
import { useAsync } from './useAsync';

/** GET /storefront/site, loaded once. Falls back to site.config values while loading or offline. */
const fallback: StorefrontSite = {
  clientID: config.clientId,
  companyName: config.name,
  currency: 'ZAR',
  deliveryOptions: [],
  whatsappChatUrl: null,
};

const SiteContext = createContext<{ site: StorefrontSite; error?: string }>({ site: fallback });

export function SiteProvider({ children }: { children: ReactNode }) {
  const state = useAsync(() => api('getSite'), []);
  const site = state.data ? { ...state.data, companyName: state.data.companyName || config.name } : fallback;
  return <SiteContext.Provider value={{ site, error: state.error }}>{children}</SiteContext.Provider>;
}

export const useSite = () => useContext(SiteContext);
