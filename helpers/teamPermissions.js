const DEFAULT_PERMISSIONS = {
  bookings: false,
  orders: false,
  staff: false,
  categories: false,
  preorder: false,
  voting: false,
  sales: false,
  services: false,
  products: false,
  dashboard: true,
  email_center: false,
  email_builder: false,
  newsletter: false,
};

const MODULE_PERMISSION_KEYS = [
  'bookings',
  'orders',
  'staff',
  'categories',
  'preorder',
  'voting',
  'sales',
  'services',
  'products',
  'dashboard',
];

/** Khana-admin toggles — org-wide feature access (sidebar + API). */
const FEATURE_ACCESS_KEYS = ['email_center', 'email_builder', 'newsletter'];

function fullPermissions() {
  return {
    bookings: true,
    orders: true,
    staff: true,
    categories: true,
    preorder: true,
    voting: true,
    sales: true,
    services: true,
    products: true,
    dashboard: true,
    email_center: true,
    email_builder: true,
    newsletter: true,
  };
}

function permissionsFromClient(client) {
  if (!client?.permissions) return { ...DEFAULT_PERMISSIONS };
  const p = client.permissions;
  return {
    bookings: !!p.bookings,
    orders: !!p.orders,
    staff: !!p.staff,
    categories: !!p.categories,
    preorder: !!p.preorder,
    voting: !!p.voting,
    sales: !!p.sales,
    services: !!p.services,
    products: !!p.products,
    dashboard: p.dashboard !== false,
    email_center: !!p.email_center,
    email_builder: !!p.email_builder,
    newsletter: !!p.newsletter,
  };
}

function normalizePermissions(input = {}) {
  return {
    bookings: !!input.bookings,
    orders: !!input.orders,
    staff: !!input.staff,
    categories: !!input.categories,
    preorder: !!input.preorder,
    voting: !!input.voting,
    sales: !!input.sales,
    services: !!input.services,
    products: !!input.products,
    dashboard: input.dashboard !== false,
    email_center: !!input.email_center,
    email_builder: !!input.email_builder,
    newsletter: !!input.newsletter,
  };
}

/**
 * Merge team member module permissions with Khana-granted client caps.
 * Module flags (products, services, etc.) require both member AND client to allow.
 * Feature flags (Email Center, etc.) follow client-level Khana admin toggles.
 */
function applyClientFeatureAccess(memberPerms, client) {
  const member = normalizePermissions(memberPerms || {});
  const caps = permissionsFromClient(client);
  const dashboardOk = member.dashboard !== false && caps.dashboard !== false;

  const merged = { ...DEFAULT_PERMISSIONS };

  for (const key of MODULE_PERMISSION_KEYS) {
    if (key === 'dashboard') {
      merged.dashboard = dashboardOk;
    } else {
      merged[key] = !!member[key] && !!caps[key];
    }
  }

  for (const key of FEATURE_ACCESS_KEYS) {
    merged[key] = dashboardOk && !!caps[key];
  }

  return merged;
}

const TEAM_MANAGER_ROLES = new Set(['owner', 'admin']);

function canManageTeam(orgRole) {
  return TEAM_MANAGER_ROLES.has(orgRole);
}

module.exports = {
  DEFAULT_PERMISSIONS,
  MODULE_PERMISSION_KEYS,
  FEATURE_ACCESS_KEYS,
  fullPermissions,
  permissionsFromClient,
  normalizePermissions,
  applyClientFeatureAccess,
  canManageTeam,
  TEAM_MANAGER_ROLES,
};
