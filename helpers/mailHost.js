/**
 * Resolve SMTP/IMAP hosts for cPanel / Roundcube and common providers.
 *
 * cPanel: incoming and outgoing are usually the SAME host (mail.yourdomain.com on 465/993).
 * Do not rewrite mail.* → smtp.* (smtp subdomain often does not exist in DNS).
 * Roundcube "Server" in cPanel → Email → Connect Devices: copy the FULL hostname (must contain a dot).
 */

const SMTP_WELL_KNOWN = {
  'gmail.com': 'smtp.gmail.com',
  'googlemail.com': 'smtp.gmail.com',
  'outlook.com': 'smtp.office365.com',
  'hotmail.com': 'smtp.office365.com',
  'live.com': 'smtp.office365.com',
  'msn.com': 'smtp.office365.com',
};

const IMAP_WELL_KNOWN = {
  'gmail.com': 'imap.gmail.com',
  'googlemail.com': 'imap.gmail.com',
  'outlook.com': 'outlook.office365.com',
  'hotmail.com': 'outlook.office365.com',
  'live.com': 'outlook.office365.com',
  'msn.com': 'outlook.office365.com',
};

function sanitizeHostInput(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  let h = raw.trim();
  h = h.replace(/^https?:\/\//i, '').split('/')[0].split('?')[0] || '';
  if (h.includes(':') && !h.startsWith('[')) {
    const parts = h.split(':');
    if (parts.length === 2 && /^\d+$/.test(parts[1])) h = parts[0];
  }
  return h.trim();
}

/** Reject single-label "hostnames" (e.g. partial cPanel id without .prod.secureserver.net). */
function isLikelyFqdn(host) {
  if (!host || typeof host !== 'string') return false;
  const h = host.trim().toLowerCase();
  if (h === 'localhost') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (/^\[[\da-f:]+\]$/i.test(h)) return true;
  return h.includes('.');
}

/** Shared outbound server from env. Ignores values that are not a full hostname. */
function globalSmtpHost() {
  const h = sanitizeHostInput(process.env.GLOBAL_SMTP_HOST || process.env.GOBAL_SMTP_HOST);
  if (!h) return '';
  if (!isLikelyFqdn(h)) {
    console.warn(
      '[mailHost] GLOBAL_SMTP_HOST must be a full hostname (e.g. mail.yourdomain.com or server.host.com). cPanel → Email Accounts → Connect Devices / Roundcube settings. Ignoring:',
      h
    );
    return '';
  }
  return h;
}

function globalSmtpPort() {
  const g = process.env.GLOBAL_SMTP_PORT;
  if (g == null || String(g).trim() === '') return null;
  const n = Number(g);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractEmailDomain(email) {
  if (!email || typeof email !== 'string') return '';
  let s = email.trim();
  const angle = s.match(/<([^>]+)>/);
  if (angle) s = angle[1].trim();
  const at = s.lastIndexOf('@');
  if (at < 0 || at === s.length - 1) return '';
  return s.slice(at + 1).toLowerCase().replace(/[\s>]/g, '');
}

function hostFromReturnUrl(returnUrl) {
  if (!returnUrl || typeof returnUrl !== 'string') return '';
  try {
    const stripped = returnUrl.replace(/^https?:\/\//i, '').split('/')[0].trim();
    if (!stripped || stripped.includes(' ') || !stripped.includes('.')) return '';
    return stripped.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Derive SMTP host from stored IMAP host.
 * cPanel: mail.domain.com is used for both IMAP and SMTP — return unchanged.
 */
function imapHostToSmtp(imapHost) {
  if (!imapHost || typeof imapHost !== 'string') return '';
  const h = imapHost.trim();
  if (!h) return '';

  const lower = h.toLowerCase();
  if (lower === 'imap.gmail.com' || lower.endsWith('.imap.gmail.com')) {
    return lower.replace(/^imap\./, 'smtp.');
  }
  if (lower.includes('outlook.office365.com')) {
    return 'smtp.office365.com';
  }

  if (/^mail\./i.test(h)) return h;
  if (/^imap\./i.test(h)) return h.replace(/^imap\./i, 'mail.');
  return h.replace(/^mail\./i, 'smtp.').replace(/^imap\./i, 'smtp.');
}

/**
 * After sending via SMTP, append to Sent over IMAP. Map SMTP hostname to IMAP hostname.
 */
function smtpHostToImapForSent(smtpHost) {
  if (!smtpHost || typeof smtpHost !== 'string') return 'localhost';
  const t = smtpHost.trim();
  const lower = t.toLowerCase();
  if (lower === 'smtp.gmail.com') return 'imap.gmail.com';
  if (lower === 'smtp.office365.com') return 'outlook.office365.com';
  if (/^mail\./i.test(t)) return t;
  if (/^imap\./i.test(t)) return t;
  if (/^smtp\./i.test(t)) return t.replace(/^smtp\./i, 'mail.');
  return t;
}

function preferredMailDomain(client) {
  const fromEmail = extractEmailDomain(client?.businessEmail);
  if (fromEmail) return fromEmail;
  return hostFromReturnUrl(client?.return_url);
}

/**
 * Same strategy as utils/email.js createTransporter: mail.{domainFromEmail} for cPanel,
 * before GLOBAL_SMTP_HOST (global is only a last resort so a bad env host cannot override).
 */
function resolveSmtpHost(client) {
  const explicit = sanitizeHostInput(client?.smtpHost);
  if (explicit) {
    if (isLikelyFqdn(explicit)) return explicit;
    console.warn(
      '[mailHost] Client smtpHost must be a full hostname (see cPanel → Email → Connect Devices). Ignoring:',
      explicit
    );
  }

  const fromImap = imapHostToSmtp(client?.imapHost);
  if (fromImap && isLikelyFqdn(fromImap)) return fromImap;

  const emailDomain = extractEmailDomain(client?.businessEmail);
  if (emailDomain) {
    if (SMTP_WELL_KNOWN[emailDomain]) return SMTP_WELL_KNOWN[emailDomain];
    return `mail.${emailDomain}`;
  }

  const ru = hostFromReturnUrl(client?.return_url);
  if (ru) {
    return `mail.${ru}`;
  }

  const globalHost = globalSmtpHost();
  if (globalHost) return globalHost;

  return '';
}

/**
 * Matches legacy booking/order mail: port 465 + secure for cPanel mail.* hosts.
 * Pass resolved smtpHost so Gmail/Office365 can use 587.
 */
function resolveSmtpPort(client, smtpHost) {
  const p = Number(client?.smtpPort);
  if (Number.isFinite(p) && p > 0) return p;
  const g = globalSmtpPort();
  if (g != null) return g;
  const h = (smtpHost || '').toLowerCase();
  if (h.includes('gmail.com') || h.includes('office365.com') || h.includes('outlook.office365.com')) {
    return 587;
  }
  return 465;
}

function resolveSmtpSecure(port) {
  return Number(port) === 465;
}

function resolveImapHost(client) {
  const explicit = sanitizeHostInput(client?.imapHost);
  if (explicit && isLikelyFqdn(explicit)) return explicit;
  if (explicit && !isLikelyFqdn(explicit)) {
    console.warn('[mailHost] Client imapHost is not a full hostname; ignoring:', explicit);
  }

  const domain = preferredMailDomain(client);
  if (!domain) return 'localhost';
  if (IMAP_WELL_KNOWN[domain]) return IMAP_WELL_KNOWN[domain];
  return `mail.${domain}`;
}

function resolveImapPort(client, defaultPort = 993) {
  const p = Number(client?.imapPort);
  if (Number.isFinite(p) && p > 0) return p;
  return defaultPort;
}

function resolveSmtpConnection(client) {
  const host = resolveSmtpHost(client);
  const port = resolveSmtpPort(client, host);
  const secure = resolveSmtpSecure(port);
  return { host, port, secure };
}

module.exports = {
  extractEmailDomain,
  preferredMailDomain,
  sanitizeHostInput,
  isLikelyFqdn,
  resolveSmtpHost,
  resolveSmtpPort,
  resolveSmtpSecure,
  resolveSmtpConnection,
  resolveImapHost,
  resolveImapPort,
  imapHostToSmtp,
  smtpHostToImapForSent,
};
