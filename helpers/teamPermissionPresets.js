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
    },
  },
  viewOnly: {
    id: 'viewOnly',
    label: 'View only',
    description: 'Dashboard access with read-only modules enabled',
    permissions: {
      dashboard: true,
      products: true,
      orders: true,
      bookings: true,
      services: true,
      staff: false,
      categories: true,
      sales: false,
      preorder: false,
      voting: false,
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
