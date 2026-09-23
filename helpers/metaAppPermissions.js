/**
 * Meta App Review permission state (Sep 2026).
 * Update when App Review approvals change.
 *
 * Live review snapshot:
 * - New request in progress: ads_management
 * - Existing access renewing (already approved): ads_read, business_management,
 *   Instagram, WhatsApp (incl. manage_events), pages_*, Marketing API Access Tier, public_profile
 */

const APPROVED_PERMISSIONS = [
  'public_profile',
  'pages_show_list',
  'pages_read_engagement',
  'business_management',
  'whatsapp_business_management',
  'whatsapp_business_messaging',
  'whatsapp_business_manage_events',
  'ads_read',
  'instagram_basic',
  'instagram_content_publish',
];

/**
 * Still waiting on Meta (new request). Until Advanced Access is live for customers,
 * manage/create ads may only work for roles on your app / Development mode.
 */
const PENDING_PERMISSIONS = ['ads_management'];

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
    status: 'approved',
    blocks: 'WhatsApp Conversions API / click-to-WhatsApp attribution',
  },
  business_management: {
    label: 'Business Manager access',
    status: 'approved',
    blocks: 'List businesses, create/select ad accounts, assets',
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
    status: 'approved',
    blocks: 'Ad insights and campaign reporting in Khana',
  },
  ads_management: {
    label: 'Manage ads',
    status: 'pending',
    blocks: 'Create/pause campaigns and boosts from Khana',
    resubmit:
      'Already submitted — Review in progress. Screen recording: create a draft/paused campaign or boost from Khana Meta Ads.',
  },
  instagram_basic: {
    label: 'Instagram profile',
    status: 'approved',
    blocks: 'Resolve IG account linked to Page, IG organic list',
  },
  instagram_content_publish: {
    label: 'Instagram publishing',
    status: 'approved',
    blocks: 'Publish Instagram content from Khana',
  },
};

const META_BUSINESS_ADMIN_HELP = [
  'Sign in to Facebook with the personal profile that is Admin on the Meta Business Portfolio (not only Page Editor).',
  'Meta Business Settings → People → your name must show Full control (Admin).',
  'The WhatsApp Business Account must live under that same Business Portfolio.',
  'In Developers → App → Login for Business configuration: include approved scopes only. Keep ads_management out of Live customer config until Meta approves the new request; roles on the app can still test it.',
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
    // Create/select ad accounts work with business_management; full campaign ops need ads_management.
    adsReadAvailable: granted.has('ads_read'),
    adsManageAvailable: granted.has('ads_management'),
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
