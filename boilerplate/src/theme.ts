import type { SiteTheme } from './config';

/** Turn the theme config into CSS variables on <html>. styles.css only reads these. */
export function applyTheme(theme: SiteTheme): void {
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(theme.colors)) root.setProperty(`--c-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`, v);
  root.setProperty('--font-heading', theme.fonts.heading);
  root.setProperty('--font-body', theme.fonts.body);
  root.setProperty('--radius', theme.radius);
  if (theme.fonts.googleFontsUrl && !document.querySelector('link[data-site-fonts]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = theme.fonts.googleFontsUrl;
    link.dataset.siteFonts = '';
    document.head.appendChild(link);
  }
}
