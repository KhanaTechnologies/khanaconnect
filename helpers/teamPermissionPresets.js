const { normalizePermissions, permissionsFromClient } = require('./teamPermissions');

const PERMISSION_KEYS = [
  'dashboard',
  'products',
  'orders',
  'bookings',
  'services',
  'staff',
  'categories',
  'sales',
  'preorder',
  'voting',
];

const ALL_MODULES_VIEW = {
  dashboard: true,
  products: true,
  orders: true,
  bookings: true,
  services: true,
  staff: true,
  categories: true,
  sales: true,
  preorder: true,
  voting: true,
  readOnly: true,
};

const ROLE_PRESETS = {
  manager: {
    id: 'manager',
    label: 'Manager',
    description: 'Full module access except team management',
    permissions: {
      dashboard: true,
      products: true,
      orders: true,
      bookings: true,
      services: true,
      staff: true,
      categories: true,
      sales: true,
      preorder: true,
      voting: true,
      readOnly: false,
    },
  },
  frontDesk: {
    id: 'frontDesk',
    label: 'Front desk',
    description: 'Orders and bookings only',
    permissions: {
      dashboard: true,
      products: false,
      orders: true,
      bookings: true,
      services: false,
      staff: false,
      categories: false,
      sales: false,
      preorder: false,
      voting: false,
      readOnly: false,
    },
  },
  marketing: {
    id: 'marketing',
    label: 'Marketing',
    description: 'Sales, campaigns, and email tools',
    permissions: {
      dashboard: true,
      products: true,
      orders: false,
      bookings: false,
      services: false,
      staff: false,
      categories: true,
      sales: true,
      preorder: true,
      voting: true,
      readOnly: false,
    },
  },
  catalog: {
    id: 'catalog',
    label: 'Catalog',
    description: 'Products and categories',
    permissions: {
      dashboard: true,
      products: true,
      orders: false,
      bookings: false,
      services: false,
      staff: false,
      categories: true,
      sales: false,
      preorder: false,
      voting: false,
      readOnly: false,
    },
  },
  viewOnly: {
    id: 'viewOnly',
    label: 'View only',
    description: 'Can open all modules, but cannot Create, Edit, or Delete',
    permissions: {
      ...ALL_MODULES_VIEW,
    },
  },
  /** App Review / external testers — same as view only (browse everything, no CUD). */
  metaReviewer: {
    id: 'metaReviewer',
    label: 'Meta reviewer',
    description: 'See all tabs for App Review; Create / Edit / Delete blocked (Meta test events still allowed)',
    permissions: {
      ...ALL_MODULES_VIEW,
    },
  },
};

function listPermissionPresets() {
  return Object.values(ROLE_PRESETS).map((preset) => ({
    id: preset.id,
    label: preset.label,
    description: preset.description,
    permissions: { ...preset.permissions },
  }));
}

function permissionsFromPreset(presetId) {
  const preset = ROLE_PRESETS[presetId];
  if (!preset) return null;
  return normalizePermissions(preset.permissions);
}

function permissionsFromMember(member) {
  if (!member?.permissions) return null;
  return normalizePermissions(
    member.permissions?.toObject?.() || member.permissions
  );
}

function resolveNewMemberPermissions({ presetId, copyFromMember, client }) {
  if (copyFromMember?.permissions) {
    return permissionsFromMember(copyFromMember);
  }
  if (presetId) {
    const fromPreset = permissionsFromPreset(presetId);
    if (fromPreset) return fromPreset;
  }
  return permissionsFromClient(client);
}

module.exports = {
  PERMISSION_KEYS,
  ROLE_PRESETS,
  listPermissionPresets,
  permissionsFromPreset,
  permissionsFromMember,
  resolveNewMemberPermissions,
};
