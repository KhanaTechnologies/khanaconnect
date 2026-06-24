const Customer = require('../models/customer');
const { Order } = require('../models/order');
const Product = require('../models/product');
const WishList = require('../models/wishList');
const Waitlist = require('../models/waitlist');
const DiscountCode = require('../models/discountCode');
const Booking = require('../models/booking');
const { mergeRevenueSettings } = require('./revenueDefaults');

const MS_DAY = 24 * 60 * 60 * 1000;

function cartValue(customer) {
  return (customer.cart || []).reduce(
    (sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 1),
    0
  );
}

function isAbandonedCart(customer) {
  if (!customer.cart || customer.cart.length === 0) return false;
  const idle =
    customer.lastActivity &&
    Date.now() - new Date(customer.lastActivity).getTime() > MS_DAY;
  return idle || Number(customer.totalOrders || 0) === 0;
}

async function getAbandonedCarts(clientID, limit = 50) {
  const customers = await Customer.find({
    clientID,
    'cart.0': { $exists: true },
  })
    .select('customerFirstName customerLastName emailAddress cart lastActivity totalOrders cartReminder')
    .limit(500);

  return customers
    .filter(isAbandonedCart)
    .map((c) => ({
      customerId: c._id,
      name: `${c.customerFirstName || ''} ${c.customerLastName || ''}`.trim(),
      email: c.emailAddress,
      itemCount: c.cart.length,
      cartValue: cartValue(c),
      lastActivity: c.lastActivity,
      lastReminderSent: c.cartReminder?.lastSent || null,
      items: (c.cart || []).map((i) => ({
        productName: i.productName,
        quantity: i.quantity,
        price: i.price,
      })),
    }))
    .sort((a, b) => b.cartValue - a.cartValue)
    .slice(0, limit);
}

async function getDiscountAttribution(clientID) {
  const orders = await Order.find({ clientID, paid: true, checkoutCode: { $exists: true, $ne: '' } })
    .select('checkoutCode discountAmount finalPrice totalPrice dateOrdered')
    .sort({ dateOrdered: -1 })
    .limit(500);

  const byCode = {};
  for (const o of orders) {
    const code = o.checkoutCode;
    if (!byCode[code]) {
      byCode[code] = { code, orderCount: 0, revenue: 0, discountGiven: 0 };
    }
    byCode[code].orderCount += 1;
    byCode[code].revenue += Number(o.finalPrice || o.totalPrice || 0);
    byCode[code].discountGiven += Number(o.discountAmount || 0);
  }

  const codes = await DiscountCode.find({ clientID }).select('code discount usageCount isActive');
  const codeMeta = Object.fromEntries(codes.map((c) => [c.code, c]));

  return Object.values(byCode)
    .map((row) => ({
      ...row,
      discountPercent: codeMeta[row.code]?.discount,
      usageCount: codeMeta[row.code]?.usageCount,
      isActive: codeMeta[row.code]?.isActive,
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

async function getWishlistOpportunities(clientID, limit = 10) {
  const ranked = await WishList.aggregate([
    { $match: { clientID } },
    { $unwind: '$items' },
    {
      $group: {
        _id: {
          productId: { $ifNull: ['$items.product', '$items.productId'] },
          variant: { $ifNull: ['$items.variantValue', ''] },
        },
        saveCount: { $sum: 1 },
        customerCount: { $addToSet: '$customerID' },
      },
    },
    { $match: { '_id.productId': { $ne: null } } },
    { $sort: { saveCount: -1 } },
    { $limit: limit },
  ]);

  const productIds = ranked.map((r) => r._id.productId).filter(Boolean);
  const products = await Product.find({ _id: { $in: productIds }, clientID }).select(
    'productName price countInStock salePercentage'
  );
  const productMap = Object.fromEntries(products.map((p) => [String(p._id), p]));

  return ranked.map((r) => {
    const pid = r._id.productId;
    const p = productMap[String(pid)];
    const saves = r.saveCount || 0;
    const shoppers = Array.isArray(r.customerCount) ? r.customerCount.length : saves;
    return {
      type: 'wishlist_demand',
      productId: pid,
      productName: p?.productName || 'Product',
      saveCount: saves,
      customerCount: shoppers,
      countInStock: p?.countInStock,
      suggestedAction: `Promote to ${shoppers} wishlist saver${shoppers === 1 ? '' : 's'} — sale or newsletter`,
    };
  });
}

async function getInventoryOpportunities(clientID, settings) {
  if (!settings.inventoryPromosEnabled) return [];

  const threshold = settings.lowStockThreshold || 5;
  const slowDays = settings.slowMoverDays || 60;
  const cutoff = new Date(Date.now() - slowDays * MS_DAY);

  const products = await Product.find({ clientID, countInStock: { $gt: 0 } }).select(
    'productName countInStock price updatedAt createdAt'
  );

  const recentOrderItems = await Order.find({
    clientID,
    paid: true,
    dateOrdered: { $gte: cutoff },
  }).select('orderItems');

  const soldProductIds = new Set();
  for (const o of recentOrderItems) {
    for (const itemId of o.orderItems || []) {
      soldProductIds.add(String(itemId));
    }
  }

  const opportunities = [];

  for (const p of products) {
    if (p.countInStock <= threshold) {
      opportunities.push({
        type: 'low_stock',
        productId: p._id,
        productName: p.productName,
        countInStock: p.countInStock,
        suggestedAction: `Only ${p.countInStock} left — urgency email or promo`,
      });
    }
  }

  for (const p of products) {
    const updated = p.updatedAt || p.createdAt;
    if (p.countInStock > threshold * 3 && updated < cutoff) {
      opportunities.push({
        type: 'slow_mover',
        productId: p._id,
        productName: p.productName,
        countInStock: p.countInStock,
        suggestedAction: 'Clearance sale or bundle with a bestseller',
      });
    }
  }

  return opportunities.slice(0, 15);
}

async function getBookingOpportunities(clientID, settings) {
  if (!settings.bookingOptimizerEnabled) return [];

  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * MS_DAY);

  const bookings = await Booking.find({
    clientID,
    date: { $gte: now, $lte: weekAhead },
    status: { $nin: ['cancelled', 'no-show'] },
  }).select('date time serviceId staffId status');

  const waitlistCount = await Waitlist.countDocuments({
    clientID,
    status: 'active',
  });

  const openSlots = [];
  const byDay = {};

  for (const b of bookings) {
    const day = new Date(b.date).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  }

  for (let d = 0; d < 7; d += 1) {
    const day = new Date(now.getTime() + d * MS_DAY).toISOString().slice(0, 10);
    if ((byDay[day] || 0) < 2) {
      openSlots.push({
        type: 'light_booking_day',
        date: day,
        bookingCount: byDay[day] || 0,
        suggestedAction: 'Offer a time-limited discount on open days',
      });
    }
  }

  const opportunities = openSlots.slice(0, 5).map((s) => ({
    ...s,
    waitlistCount,
  }));

  if (waitlistCount > 0) {
    opportunities.unshift({
      type: 'waitlist_demand',
      waitlistCount,
      suggestedAction: `${waitlistCount} customers on waitlist — fill cancellations or add slots`,
    });
  }

  return opportunities;
}

async function resolveSegmentCustomers(clientID, segment) {
  const preset = segment.preset || 'custom';
  const customers = await Customer.find({ clientID }).select(
    'emailAddress customerFirstName customerLastName cart totalOrders totalSpent lastActivity orderHistory preferences'
  );

  switch (preset) {
    case 'cart_abandoned':
      return customers.filter(isAbandonedCart);
    case 'wishlist_savers': {
      const lists = await WishList.find({ clientID }).select('customerID');
      const ids = new Set(lists.map((l) => String(l.customerID)));
      return customers.filter((c) => ids.has(String(c._id)));
    }
    case 'high_value':
      return customers.filter((c) => Number(c.totalSpent || 0) >= 500);
    case 'inactive_60': {
      const cutoff = Date.now() - 60 * MS_DAY;
      return customers.filter(
        (c) => c.lastActivity && new Date(c.lastActivity).getTime() < cutoff
      );
    }
    case 'product_buyers':
      return customers.filter((c) => Number(c.totalOrders || 0) > 0);
    case 'service_bookers':
      return customers.filter((c) =>
        (c.orderHistory || []).some((o) =>
          (o.products || []).some((p) => String(p.productId || '').length > 0)
        )
      );
    default:
      return [];
  }
}

async function getSocialProofFeed(clientID, settings) {
  if (!settings.socialProofEnabled) {
    return { enabled: false, items: [] };
  }

  const items = [];

  if (settings.showRecentOrders) {
    const recent = await Order.find({ clientID, paid: true })
      .sort({ dateOrdered: -1 })
      .limit(5)
      .populate('customer', 'customerFirstName customerLastName')
      .select('dateOrdered finalPrice totalPrice');

    for (const o of recent) {
      const first = o.customer?.customerFirstName || 'Someone';
      items.push({
        type: 'recent_order',
        message: `${first} placed an order recently`,
        at: o.dateOrdered,
      });
    }
  }

  if (settings.showWishlistSaves) {
    const top = await getWishlistOpportunities(clientID, 3);
    for (const w of top) {
      items.push({
        type: 'wishlist_popularity',
        message: `${w.saveCount} people saved ${w.productName}`,
        productId: w.productId,
      });
    }
  }

  if (settings.showStockUrgency && settings.inventoryPromosEnabled) {
    const low = await Product.find({
      clientID,
      countInStock: { $gt: 0, $lte: settings.lowStockThreshold || 5 },
    })
      .select('productName countInStock')
      .limit(3);
    for (const p of low) {
      items.push({
        type: 'stock_urgency',
        message: `Only ${p.countInStock} left of ${p.productName}`,
        productId: p._id,
      });
    }
  }

  return { enabled: true, items: items.slice(0, 12) };
}

const {
  resolveRevenueCapabilities,
  effectiveBusinessType,
  moduleAllowed,
} = require('./revenueCapabilities');

async function buildOverview(clientID, clientDoc) {
  const settings = mergeRevenueSettings(clientDoc?.revenueSettings);
  const capabilities = resolveRevenueCapabilities(clientDoc);
  const businessType = effectiveBusinessType(settings, capabilities);

  const retailEnabled = businessType === 'retail' || businessType === 'mixed';
  const servicesEnabled = businessType === 'services' || businessType === 'mixed';

  const [abandonedCarts, discountAttribution, wishlistOps] = await Promise.all([
    settings.cartRecoveryEnabled &&
    retailEnabled &&
    capabilities.orders
      ? getAbandonedCarts(clientID, 10)
      : [],
    capabilities.sales ? getDiscountAttribution(clientID) : [],
    retailEnabled && (capabilities.sales || capabilities.products)
      ? getWishlistOpportunities(clientID, 5)
      : [],
  ]);

  const inventoryOps =
    retailEnabled && capabilities.products
      ? await getInventoryOpportunities(clientID, settings)
      : [];
  const bookingOps =
    servicesEnabled && capabilities.bookings
      ? await getBookingOpportunities(clientID, settings)
      : [];

  const totalAbandonedValue = abandonedCarts.reduce((s, c) => s + c.cartValue, 0);
  const totalDiscountRevenue = discountAttribution.reduce((s, d) => s + d.revenue, 0);

  const actions = [];

  if (abandonedCarts.length > 0) {
    actions.push({
      id: 'cart_recovery',
      priority: 'high',
      title: `${abandonedCarts.length} abandoned carts (R${totalAbandonedValue.toFixed(0)} potential)`,
      module: 'cart_recovery',
      businessTypes: ['retail', 'mixed'],
    });
  }

  for (const w of wishlistOps.slice(0, 3)) {
    actions.push({
      id: `wishlist_${w.productId}`,
      priority: 'medium',
      title: `${w.productName} — ${w.saveCount} wishlist save${w.saveCount === 1 ? '' : 's'}${w.customerCount ? ` from ${w.customerCount} customer${w.customerCount === 1 ? '' : 's'}` : ''}`,
      module: 'wishlist',
      businessTypes: ['retail', 'mixed'],
    });
  }

  for (const inv of inventoryOps.slice(0, 3)) {
    actions.push({
      id: `inv_${inv.productId}_${inv.type}`,
      priority: inv.type === 'low_stock' ? 'high' : 'medium',
      title: `${inv.productName}: ${inv.suggestedAction}`,
      module: 'inventory',
      businessTypes: ['retail', 'mixed'],
    });
  }

  for (const b of bookingOps.slice(0, 3)) {
    actions.push({
      id: `booking_${b.type}_${b.date || 'waitlist'}`,
      priority: 'medium',
      title: b.suggestedAction,
      module: 'bookings',
      businessTypes: ['services', 'mixed'],
    });
  }

  return {
    settings: { ...settings, businessType },
    capabilities,
    summary: {
      abandonedCartCount: abandonedCarts.length,
      potentialCartRevenue: totalAbandonedValue,
      discountCodeRevenue: totalDiscountRevenue,
      activePromoCodes: discountAttribution.length,
      inventoryOpportunities: inventoryOps.length,
      bookingOpportunities: bookingOps.length,
      wishlistOpportunities: wishlistOps.length,
    },
    actions: actions.filter(
      (a) =>
        a.businessTypes.includes(businessType) &&
        moduleAllowed(a.module, businessType, capabilities)
    ),
    abandonedCartsPreview: abandonedCarts.slice(0, 5),
    discountAttribution: discountAttribution.slice(0, 10),
    wishlistOpportunities: wishlistOps,
    inventoryOpportunities: inventoryOps,
    bookingOpportunities: bookingOps,
  };
}

module.exports = {
  getAbandonedCarts,
  getDiscountAttribution,
  getWishlistOpportunities,
  getInventoryOpportunities,
  getBookingOpportunities,
  resolveSegmentCustomers,
  getSocialProofFeed,
  buildOverview,
  cartValue,
  isAbandonedCart,
};
