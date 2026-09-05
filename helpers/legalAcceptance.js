const { currentPolicyVersions, publicLegalMeta } = require('./legalPolicies');

function emptyLegalAcceptance() {
  return {
    tosVersion: '',
    aupVersion: '',
    acceptedAt: null,
    acceptedByEmail: '',
    acceptedByName: '',
    ip: '',
    userAgent: '',
    source: '',
  };
}

function isAcceptedLegalFlag(body = {}) {
  const value = body.acceptedLegalTerms ?? body.acceptLegalTerms ?? body.acceptedTerms;
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
}

function requestClientIp(req) {
  if (!req) return '';
  const forwarded = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return forwarded || req.ip || '';
}

function recordLegalAcceptance({ email = '', name = '', ip = '', userAgent = '', source = 'signup' } = {}) {
  const versions = currentPolicyVersions();
  return {
    tosVersion: versions.tos,
    aupVersion: versions.aup,
    acceptedAt: new Date(),
    acceptedByEmail: String(email || '').trim().toLowerCase(),
    acceptedByName: String(name || '').trim(),
    ip: String(ip || '').slice(0, 80),
    userAgent: String(userAgent || '').slice(0, 500),
    source: source || 'signup',
  };
}

function isCurrentLegalAcceptance(legal) {
  if (!legal?.acceptedAt) return false;
  const versions = currentPolicyVersions();
  return legal.tosVersion === versions.tos && legal.aupVersion === versions.aup;
}

function serializeLegalStatus(client) {
  const legal = client?.legalAcceptance || {};
  const accepted = isCurrentLegalAcceptance(legal);
  const platformAdmin = client?.role === 'admin';
  return {
    accepted,
    required: !platformAdmin && !accepted,
    acceptedAt: legal.acceptedAt || null,
    acceptedVersions: {
      tos: legal.tosVersion || '',
      aup: legal.aupVersion || '',
    },
    ...publicLegalMeta(),
  };
}

function applyLegalAcceptanceFromRequest(body, req, extras = {}) {
  if (!isAcceptedLegalFlag(body)) return null;
  return recordLegalAcceptance({
    email: extras.email || body.businessEmail || body.email || body.acceptedByEmail,
    name: extras.name || body.companyName || body.acceptedByName,
    ip: requestClientIp(req),
    userAgent: req?.headers?.['user-agent'] || '',
    source: extras.source || 'signup',
  });
}

function missingLegalAcceptanceError() {
  const meta = publicLegalMeta();
  return {
    success: false,
    error: 'You must accept the Merchant Terms of Service and Acceptable Use Policy to continue.',
    code: 'LEGAL_ACCEPTANCE_REQUIRED',
    legal: meta,
  };
}

module.exports = {
  emptyLegalAcceptance,
  isAcceptedLegalFlag,
  requestClientIp,
  recordLegalAcceptance,
  isCurrentLegalAcceptance,
  serializeLegalStatus,
  applyLegalAcceptanceFromRequest,
  missingLegalAcceptanceError,
};
