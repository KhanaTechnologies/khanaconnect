/**
 * TLS options shared by every SMTP / IMAP connection (system alerts and client mailboxes).
 *
 * Certificate verification blocks a man-in-the-middle from capturing mailbox passwords, but
 * some shared cPanel hosts present a certificate that doesn't match the client's mail domain,
 * so enforcing it everywhere would silently stop their mail. Turn it on per host with
 * MAIL_TLS_VERIFY_HOSTS (comma-separated, e.g. "mail.khanatechnologies.co.za,mail.herbeauty.co.za"),
 * or for every host with MAIL_TLS_VERIFY=true.
 */
function verifiedHosts() {
  return String(process.env.MAIL_TLS_VERIFY_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function mailTlsOptions(host = '') {
  const verifyAll = String(process.env.MAIL_TLS_VERIFY || '').toLowerCase() === 'true';
  const h = String(host || '').trim().toLowerCase();
  return {
    rejectUnauthorized: verifyAll || (!!h && verifiedHosts().includes(h)),
    minVersion: 'TLSv1.2',
  };
}

module.exports = { mailTlsOptions };
