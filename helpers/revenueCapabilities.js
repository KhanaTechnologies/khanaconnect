const { mergeRevenueSettings } = require('./revenueDefaults');

function resolveRevenueCapabilities(clientDoc) {
  const perms = clientDoc?.permissions || {};
  const isAdmin = (clientDoc?.role || 'client') === 'admin';

  return {
    orders: isAdmin || !!perms.orders,
    products: isAdmin || !!perms.products,
    bookings: isAdmin || !!perms.bookings,
    sales: isAdmin || !!perms.sales,
    services: isAdmin || !!perms.services,
  };
}

function effectiveBusinessType(settings, caps) {
  const preferred = settings?.businessType || 'mixed';
  const retailOk = caps.orders || caps.products || caps.sales;
  const servicesOk = caps.bookings || caps.services;

  if (preferred === 'mixed') {
    if (retailOk && servicesOk) return 'mixed';
    if (servicesOk) return 'services';
    if (retailOk) return 'retail';
    return 'mixed';
  }
  if (preferred === 'retail' && !retailOk && servicesOk) return 'services';
  if (preferred === 'services' && !servicesOk && retailOk) return 'retail';
  if (preferred === 'retail' && !retailOk) return servicesOk ? 'services' : 'mixed';
  if (preferred === 'services' && !servicesOk) return retailOk ? 'retail' : 'mixed';
  return preferred;
}

function moduleAllowed(module, businessType, caps) {
  const retail = businessType === 'retail' || businessType === 'mixed';
  const services = businessType === 'services' || businessType === 'mixed';

  switch (module) {
    case 'cart_recovery':
      return retail && caps.orders;
    case 'inventory':
    case 'bundles':
      return retail && caps.products;
    case 'promotions':
    case 'promo_roi':
      return retail && caps.sales;
    case 'bookings':
      return services && caps.bookings;
    default:
      return true;
  }
}

module.exports = {
  resolveRevenueCapabilities,
  effectiveBusinessType,
  moduleAllowed,
  mergeRevenueSettings,
};
