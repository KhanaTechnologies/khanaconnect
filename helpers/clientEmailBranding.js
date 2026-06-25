function resolveClientEmailLogoUrl(client) {
  if (!client) return '';
  const url = client.emailLogoUrl ?? client.emailLogo ?? '';
  return String(url || '').trim();
}

function brandingForTransactionalEmail(client, formattedClientName) {
  const logoUrl = resolveClientEmailLogoUrl(client);
  return {
    formattedClientName,
    emailLogoUrl: logoUrl || undefined,
    logoUrl: logoUrl || undefined,
  };
}

module.exports = {
  resolveClientEmailLogoUrl,
  brandingForTransactionalEmail,
};
