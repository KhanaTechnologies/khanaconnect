const ACTIVITY_CATEGORIES = [
  { id: 'team', label: 'Team changes', description: 'Invites, new members, permission updates' },
  { id: 'orders', label: 'Orders', description: 'Order created, updated, or removed' },
  { id: 'products', label: 'Products', description: 'Catalog changes' },
  { id: 'bookings', label: 'Bookings', description: 'Appointments and waitlist' },
  { id: 'sales', label: 'Sales & promotions', description: 'Discount codes and promotions' },
  { id: 'email', label: 'Email & newsletters', description: 'Newsletters and bulk email sends' },
  { id: 'campaigns', label: 'Campaigns', description: 'Preorder and voting campaigns' },
  { id: 'account', label: 'Account & security', description: 'Login email and password changes' },
];

const CATEGORY_IDS = ACTIVITY_CATEGORIES.map((c) => c.id);

const DEFAULT_LOG_CATEGORIES = {
  team: true,
  orders: true,
  products: true,
  bookings: true,
  sales: true,
  email: true,
  campaigns: true,
  account: true,
};

const DEFAULT_NOTIFY_CATEGORIES = {
  team: true,
  orders: false,
  products: false,
  bookings: false,
  sales: false,
  email: true,
  campaigns: false,
  account: true,
};

function mergeCategoryFlags(stored, defaults) {
  const merged = { ...defaults };
  if (stored && typeof stored === 'object') {
    for (const id of CATEGORY_IDS) {
      if (typeof stored[id] === 'boolean') merged[id] = stored[id];
    }
  }
  return merged;
}

function mergeTeamActivitySettings(clientDoc) {
  const stored = clientDoc?.teamActivitySettings || {};
  return {
    logCategories: mergeCategoryFlags(stored.logCategories, DEFAULT_LOG_CATEGORIES),
    notifyCategories: mergeCategoryFlags(stored.notifyCategories, DEFAULT_NOTIFY_CATEGORIES),
  };
}

module.exports = {
  ACTIVITY_CATEGORIES,
  CATEGORY_IDS,
  DEFAULT_LOG_CATEGORIES,
  DEFAULT_NOTIFY_CATEGORIES,
  mergeTeamActivitySettings,
};
