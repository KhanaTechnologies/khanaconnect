/**
 * Meta App Review permission state (Aug 2026).
 * Update when App Review approvals change.
 */

const APPROVED_PERMISSIONS = [
  'public_profile',
  'pages_show_list',
  'pages_read_engagement',
  'business_management',
  'whatsapp_business_management',
  'whatsapp_business_messaging',
];

/** Request only after App Review approves them. */
const PENDING_PERMISSIONS = [
  'ads_read',
  'ads_management',
  'instagram_basic',
  'instagram_content_publish',
  'whatsapp_business_manage_events',
];

const PERMISSION_FEATURES = {
  whatsapp_business_messaging: {
    label: 'WhatsApp messaging',
    status: 'approved',
    blocks: 'Inbound/outbound WhatsApp via Cloud API',
  },
  whatsapp_business_management: {
    label: 'WhatsApp account management',
    status: 'approved',
    blocks: 'Connect WABA, templates, inbox',
  },
  whatsapp_business_manage_events: {
    label: 'WhatsApp conversion events',
    status: 'pending',
    blocks: 'WhatsApp Conversions API / click-to-WhatsApp attribution',
    resubmit:
      'App Review → WhatsApp → explain you send LeadSubmitted/Purchase events from inbound ad referrals (ctwa_clid) to the WABA dataset.',
  },
  business_management: {
    label: 'Business Manager access',
    status: 'approved',
    blocks: 'List businesses, ad accounts, assets',
  },
  pages_show_list: {
    label: 'Facebook Pages',
    status: 'approved',
    blocks: 'Select Page during Connect Facebook',
  },
  pages_read_engagement: {
    label: 'Page engagement',
    status: 'approved',
    blocks: 'Organic Page post insights',
  },
  ads_read: {
    label: 'Read ads',
    status: 'pending',
    blocks: 'Ad insights and campaign reporting in Khana',
    resubmit:
      'App Review → Marketing API → screen recording of Khana Meta Ads dashboard reading spend/impressions.',
  },
  ads_management: {
    label: 'Manage ads',
    status: 'pending',
    blocks: 'Create/pause campaigns and boosts from Khana',
    resubmit:
      'App Review → Marketing API → screen recording creating a draft campaign from Khana (test ad account).',
  },
  instagram_basic: {
    label: 'Instagram profile',
    status: 'pending',
    blocks: 'Resolve IG account linked to Page, IG organic list',
    resubmit:
      'App Review → Instagram → show IG account linked to Facebook Page in Khana organic posts view.',
  },
  instagram_content_publish: {
    label: 'Instagram publishing',
    status: 'pending',
    blocks: 'Publish/boost Instagram content from Khana',
    resubmit:
      'App Review → Instagram → show publish or boost flow (even draft) from Khana.',
  },
};

const META_BUSINESS_ADMIN_HELP = [
  'Sign in to Facebook with the personal profile that is Admin on the Meta Business Portfolio (not only Page Editor).',
  'Meta Business Settings → People → your name must show Full control (Admin).',
  'The WhatsApp Business Account must live under that same Business Portfolio.',
  'In Developers → App → Login for Business configuration, include only approved permissions (remove denied scopes until re-approved).',
  'Disconnect → Connect Facebook in Khana after changing the Login for Business config.',
];

function normalizePermissionList(granted = []) {
  const set = new Set();
  for (const row of granted) {
    const name = String(row?.permission || row || '').trim();
    if (!name) continue;
    const status = String(row?.status || 'granted').toLowerCase();
    if (status === 'granted' || status === 'declined') {
      if (status === 'granted') set.add(name);
    } else {
      set.add(name);
    }
  }
  return set;
}

function buildPermissionDiagnostics(grantedPermissions = []) {
  const granted = normalizePermissionList(grantedPermissions);
  const approvedMissing = APPROVED_PERMISSIONS.filter((p) => !granted.has(p));
  const pending = PENDING_PERMISSIONS.map((id) => ({
    id,
    ...PERMISSION_FEATURES[id],
    granted: granted.has(id),
  }));

  const blockedFeatures = pending
    .filter((p) => !p.granted)
    .map((p) => ({ id: p.id, label: p.label, blocks: p.blocks, resubmit: p.resubmit || '' }));

  return {
    granted: [...granted],
    approvedMissing,
    pending,
    blockedFeatures,
    adsAvailable: granted.has('ads_read') && granted.has('ads_management'),
    instagramAvailable: granted.has('instagram_basic'),
    instagramPublishAvailable: granted.has('instagram_content_publish'),
    whatsappConversionsAvailable: granted.has('whatsapp_business_manage_events'),
    metaBusinessAdminHelp: META_BUSINESS_ADMIN_HELP,
  };
}

function isMetaBusinessAdminError(message) {
  const msg = String(message || '').toLowerCase();
  return /owner|admin|business manager|not authorized|permission denied|(#10)|(#200)|(#100)/i.test(msg);
}

function formatMetaBusinessAdminError(originalMessage = '') {
  const base = String(originalMessage || '').trim();
  const hints = META_BUSINESS_ADMIN_HELP.map((h, i) => `${i + 1}. ${h}`).join('\n');
  return [
    base || 'Meta requires Business Portfolio Admin access for this step.',
    '',
    'You must be Admin on the Meta Business Portfolio (not only a Page role):',
    hints,
  ].join('\n');
}

module.exports = {
  APPROVED_PERMISSIONS,
  PENDING_PERMISSIONS,
  PERMISSION_FEATURES,
  META_BUSINESS_ADMIN_HELP,
  buildPermissionDiagnostics,
  isMetaBusinessAdminError,
  formatMetaBusinessAdminError,
};
