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
};

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
  };
}

function permissionsFromClient(client) {
  if (!client?.permissions) return { ...DEFAULT_PERMISSIONS };
  return {
    bookings: !!client.permissions.bookings,
    orders: !!client.permissions.orders,
    staff: !!client.permissions.staff,
    categories: !!client.permissions.categories,
    preorder: !!client.permissions.preorder,
    voting: !!client.permissions.voting,
    sales: !!client.permissions.sales,
    services: !!client.permissions.services,
    products: !!client.permissions.products,
    dashboard: client.permissions.dashboard !== false,
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
  };
}

const TEAM_MANAGER_ROLES = new Set(['owner', 'admin']);

function canManageTeam(orgRole) {
  return TEAM_MANAGER_ROLES.has(orgRole);
}

module.exports = {
  DEFAULT_PERMISSIONS,
  fullPermissions,
  permissionsFromClient,
  normalizePermissions,
  canManageTeam,
  TEAM_MANAGER_ROLES,
};
