/**
 * Public storefront payloads and guest checkout, used by routes/storefront.js.
 *
 * Everything here returns a fixed, documented shape (see the Storefront* schemas in
 * config/openapi.js). The client-site boilerplate (boilerplate/) is type-checked against
 * those schemas, and tests/boilerplateApiContract.test.js fails when they drift, so:
 * change a payload here → update config/openapi.js → regenerate the boilerplate client.
 *
 * Models and stock helpers are injected so the logic can be tested without a database.
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { catalogUnitPrice } = require('./productUnitPrice');
const { generateOrderNumber } = require('./orderStatus');

const MAX_LINES = 50;
const MAX_QTY = 99;
const OBJECT_ID = /^[a-f0-9]{24}$/i;

function httpError(status, error, code) {
  return Object.assign(new Error(error), { status, code, expose: true });
}

const clip = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const idOf = (doc) => (doc && doc._id ? String(doc._id) : doc ? String(doc) : null);

/** Same normalisation as customer registration/login in routes/customer.js. */
function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase()
    .replace(/@gmail\.co\.za$/i, '@gmail.com')
    .replace(/@googlemail\.com$/i, '@gmail.com')
    .replace(/@gmai\.com$/i, '@gmail.com')
    .replace(/@gmal\.com$/i, '@gmail.com');
}

function isPublished(product) {
  return !product.status || product.status === 'published';
}

// ------------------------------------------------------------------ payloads

function siteInfo(client) {
  const obj = client && client.toObject ? client.toObject({ getters: true }) : client || {};
  const { publicWhatsappPayload } = require('./whatsappLink');
  const whatsapp = publicWhatsappPayload(obj.whatsapp);
  return {
    clientID: obj.clientID,
    companyName: obj.companyName || '',
    currency: 'ZAR',
    deliveryOptions: (obj.deliveryOptions || [])
      .filter((d) => d && d.type)
      .map((d) => ({ type: String(d.type), price: money(d.price) })),
    whatsappChatUrl: whatsapp.chatUrl || null,
  };
}

function storefrontCategory(cat) {
  return {
    id: idOf(cat),
    name: cat.name || '',
    description: cat.description || '',
    image: cat.image || null,
    parentId: cat.parentId ? String(cat.parentId) : null,
  };
}

function storefrontProduct(p) {
  const category = p.category && typeof p.category === 'object' && p.category.name
    ? { id: idOf(p.category), name: p.category.name }
    : null;
  const stock = Math.max(0, Number(p.countInStock) || 0);
  return {
    id: idOf(p),
    name: p.productName || '',
    slug: p.slug || '',
    description: p.description || '',
    richDescription: p.richDescription || '',
    price: money(p.price),
    salePercentage: Number(p.salePercentage) || 0,
    unitPrice: catalogUnitPrice(p),
    images: Array.isArray(p.images) ? p.images.filter(Boolean) : [],
    brand: p.brand || '',
    category,
    tags: Array.isArray(p.tags) ? p.tags : [],
    isFeatured: !!p.isFeatured,
    inStock: stock > 0,
    stock,
    rating: Number(p.rating) || 0,
    numReviews: Number(p.numReviews) || 0,
    metaTitle: p.metaTitle || '',
    metaDescription: p.metaDescription || '',
    variants: (p.variants || []).map((v) => ({
      name: v.name,
      values: (v.values || []).map((val) => ({
        value: val.value,
        unitPrice: catalogUnitPrice(p, v.name, val.value),
        inStock: (Number(val.stock) || 0) > 0,
      })),
    })),
  };
}

/** order must have orderItems populated, each with product populated. */
function storefrontOrder(order) {
  const items = (order.orderItems || []).map((item) => {
    const product = item.product && typeof item.product === 'object' ? item.product : null;
    const unitPrice = money(item.variantPrice);
    const quantity = Number(item.quantity) || 0;
    return {
      productId: product ? idOf(product) : item.product ? String(item.product) : null,
      name: product ? product.productName || '' : '',
      image: product && Array.isArray(product.images) && product.images[0] ? product.images[0] : null,
      variant: item.variant || '',
      quantity,
      unitPrice,
      lineTotal: money(unitPrice * quantity),
    };
  });
  return {
    id: idOf(order),
    orderNumber: order.orderNumber || '',
    status: order.status || 'pending',
    paid: !!order.paid,
    items,
    subtotal: money(order.totalPrice),
    deliveryType: order.deliveryType || '',
    deliveryPrice: money(order.deliveryPrice),
    discountAmount: money(order.discountAmount),
    total: money(order.finalPrice),
    currency: 'ZAR',
    createdAt: order.dateOrdered ? new Date(order.dateOrdered).toISOString() : null,
  };
}

// ------------------------------------------------------------------ guest checkout

function variantStock(product, variant) {
  if (variant.name && Array.isArray(product.variants)) {
    const option = product.variants.find((v) => String(v.name) === variant.name);
    const match = option && (option.values || []).find((v) => String(v.value) === variant.value);
    if (!match) return null; // unknown variant
    return Number(match.stock) || 0;
  }
  return Number(product.countInStock) || 0;
}

/**
 * Validate a storefront order body. Prices, delivery cost and totals come from the database,
 * never from the request.
 */
function parseOrderBody(body) {
  const b = body || {};
  const c = b.customer || {};
  const s = b.shipping || {};
  const customer = {
    firstName: clip(c.firstName, 80),
    lastName: clip(c.lastName, 80),
    email: normalizeEmail(clip(c.email, 254)),
    phone: clip(c.phone, 30),
  };
  if (!customer.firstName || !customer.lastName) throw httpError(400, 'customer.firstName and customer.lastName are required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) throw httpError(400, 'A valid customer.email is required');
  if (!customer.phone) throw httpError(400, 'customer.phone is required');

  const shipping = {
    address: clip(s.address, 300),
    city: clip(s.city, 100),
    province: clip(s.province, 100),
    postalCode: clip(s.postalCode, 20),
    country: clip(s.country, 2).toUpperCase() || 'ZA',
  };
  const deliveryType = clip(b.deliveryType, 100);
  if (!deliveryType) throw httpError(400, 'deliveryType is required');

  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw httpError(400, 'items must have at least one line');
  if (items.length > MAX_LINES) throw httpError(400, `At most ${MAX_LINES} lines per order`);
  const lines = items.map((it) => {
    const productId = String((it && it.productId) || '');
    if (!OBJECT_ID.test(productId)) throw httpError(400, 'Each item needs a valid productId');
    const quantity = Math.floor(Number(it.quantity));
    if (!(quantity >= 1 && quantity <= MAX_QTY)) throw httpError(400, `quantity must be 1–${MAX_QTY}`);
    const v = it.variant && typeof it.variant === 'object' ? it.variant : {};
    return { productId, quantity, variant: { name: clip(v.name, 100), value: clip(v.value, 100) } };
  });

  return { customer, shipping, deliveryType, lines, notes: clip(b.notes, 1000) };
}

/**
 * Create an unpaid retail order for a website visitor (guest checkout).
 * Stock is reserved now, like POST /orders; helpers/expireUnpaidOrders.js releases it if the
 * order is never paid, and the PayFast ITN marks it paid (fulfillGatewayPayment).
 *
 * deps: { Product, Customer, Order, OrderItem, findCustomerByEmail, deductLineStock }
 */
async function createStorefrontOrder({ clientId, client, body, customerId = '', deps }) {
  const { Product, Customer, Order, OrderItem, findCustomerByEmail, deductLineStock } = deps;
  const input = parseOrderBody(body);

  // Delivery price comes from the client's configured delivery options.
  const options = siteInfo(client).deliveryOptions;
  let deliveryPrice = 0;
  if (options.length) {
    const opt = options.find((o) => o.type === input.deliveryType);
    if (!opt) throw httpError(400, `Unknown deliveryType. Choose one of: ${options.map((o) => o.type).join(', ')}`);
    deliveryPrice = opt.price;
  } else if (input.deliveryType.toLowerCase() !== 'collection') {
    throw httpError(400, 'This store has no delivery options set up; use deliveryType "collection"');
  }
  const needsAddress = !/collect/i.test(input.deliveryType);
  if (needsAddress && (!input.shipping.address || !input.shipping.postalCode)) {
    throw httpError(400, 'shipping.address and shipping.postalCode are required for delivery');
  }

  // Price and check every line before writing anything.
  const priced = [];
  for (const line of input.lines) {
    const product = await Product.findOne({ _id: line.productId, clientID: clientId });
    if (!product || !isPublished(product)) throw httpError(400, 'One or more products are not available', 'PRODUCT_UNAVAILABLE');
    const stock = variantStock(product, line.variant);
    if (stock == null) throw httpError(400, `Unknown option for ${product.productName}`, 'UNKNOWN_VARIANT');
    if (stock < line.quantity) {
      throw httpError(409, `Only ${stock} of ${product.productName} left`, 'OUT_OF_STOCK');
    }
    priced.push({
      product,
      quantity: line.quantity,
      variantLabel: line.variant.value || line.variant.name,
      unit: catalogUnitPrice(product, line.variant.name, line.variant.value),
    });
  }

  // Customer: the signed-in shopper, else find-or-create a guest record by email.
  let customer = null;
  if (customerId) {
    customer = await Customer.findOne({ _id: customerId, clientID: clientId });
  }
  if (!customer) customer = await findCustomerByEmail(Customer, clientId, input.customer.email);
  if (!customer) {
    customer = new Customer({
      clientID: clientId,
      customerFirstName: input.customer.firstName,
      customerLastName: input.customer.lastName,
      emailAddress: input.customer.email,
      phoneNumber: input.customer.phone,
      passwordHash: bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10),
      isVerified: false,
    });
    await customer.save();
  }

  const itemIds = [];
  for (const line of priced) {
    const item = new OrderItem({
      product: line.product._id,
      quantity: line.quantity,
      variant: line.variantLabel,
      variantPrice: line.unit,
    });
    await item.save();
    itemIds.push(item._id);
  }

  const totalPrice = money(priced.reduce((sum, l) => sum + l.unit * l.quantity, 0));
  const orderNumber = generateOrderNumber();
  const order = new Order({
    orderItems: itemIds,
    address: needsAddress ? input.shipping.address : input.shipping.address || 'Collection',
    city: input.shipping.city,
    province: input.shipping.province,
    country: input.shipping.country,
    postalCode: needsAddress ? input.shipping.postalCode : input.shipping.postalCode || '0000',
    phone: input.customer.phone,
    status: 'pending',
    orderNumber,
    invoiceNumber: `INV-${orderNumber}`,
    totalPrice,
    discountAmount: 0,
    customer: customer._id,
    deliveryPrice,
    deliveryType: input.deliveryType,
    clientID: clientId,
    finalPrice: money(totalPrice + deliveryPrice),
    orderNotes: input.notes,
    paid: false,
    stockDeducted: false,
  });
  await order.save();

  for (const line of priced) {
    await deductLineStock({
      clientId,
      productId: line.product._id,
      quantity: line.quantity,
      variant: line.variantLabel,
      orderId: String(order._id),
      reason: 'order_create',
      allowOversell: true,
    });
  }
  order.stockDeducted = true;
  await order.save();

  return { order, priced };
}

module.exports = {
  OBJECT_ID,
  httpError,
  normalizeEmail,
  isPublished,
  siteInfo,
  storefrontCategory,
  storefrontProduct,
  storefrontOrder,
  parseOrderBody,
  createStorefrontOrder,
};
