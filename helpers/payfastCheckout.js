/**
 * Server-side PayFast checkout signing for storefront orders and booking deposits.
 *
 * Storefronts used to read each client's PayFast passphrase and sign checkouts in the
 * browser. The passphrase now stays on the server: the storefront sends an order id
 * (or booking id), we build the PayFast fields from the database and sign them here.
 *
 * Signature rules (PayFast "Step 2: Create security signature" for the checkout form):
 *  - fields in PayFast's documented attribute order (NOT alphabetical; alphabetical is
 *    only for the PayFast REST API), empty values left out
 *  - each value trimmed and URL-encoded like PHP urlencode (uppercase hex, spaces as "+")
 *  - "&passphrase=<urlencoded passphrase>" appended when a passphrase is set
 *  - MD5 of that string, lowercase hex
 * Value encoding matches verifyPayFastSignature in services/saas/PayFastCreditsService.js,
 * plus the characters encodeURIComponent leaves alone (! ' ( ) * ~), which PHP encodes.
 *
 * @see https://developers.payfast.co.za/docs#step_2_signature
 */

const crypto = require('crypto');

/** PayFast checkout attribute order. Only these keys are signed and returned. */
const PAYFAST_FIELD_ORDER = [
  'merchant_id',
  'merchant_key',
  'return_url',
  'cancel_url',
  'notify_url',
  'name_first',
  'name_last',
  'email_address',
  'cell_number',
  'm_payment_id',
  'amount',
  'item_name',
  'item_description',
  'custom_int1',
  'custom_int2',
  'custom_int3',
  'custom_int4',
  'custom_int5',
  'custom_str1',
  'custom_str2',
  'custom_str3',
  'custom_str4',
  'custom_str5',
  'email_confirmation',
  'confirmation_address',
  'payment_method',
];

const ORDER_ITN_PATH = '/payments/payfast/itn';

/** PHP urlencode equivalent: uppercase hex, spaces as "+". */
function payfastEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

/**
 * Ordered, non-empty, trimmed copy of the PayFast fields (signature not included).
 * Unknown keys are dropped so nothing unsigned ends up in the form.
 */
function orderedPayfastFields(fields) {
  const out = {};
  for (const key of PAYFAST_FIELD_ORDER) {
    const raw = fields[key];
    if (raw === undefined || raw === null) continue;
    const val = String(raw).trim();
    if (val === '') continue;
    out[key] = val;
  }
  return out;
}

function payfastSignatureString(orderedFields, passphrase = '') {
  const pairs = Object.keys(orderedFields).map((k) => `${k}=${payfastEncode(orderedFields[k])}`);
  const pass = passphrase == null ? '' : String(passphrase).trim();
  if (pass) pairs.push(`passphrase=${payfastEncode(pass)}`);
  return pairs.join('&');
}

function signPayfastFields(fields, passphrase = '') {
  const ordered = orderedPayfastFields(fields);
  const signature = crypto
    .createHash('md5')
    .update(payfastSignatureString(ordered, passphrase))
    .digest('hex');
  return { ...ordered, signature };
}

/**
 * Client passphrase in plain text. Older records store it plain; records migrated by
 * /client/migrate/encrypt-merchant-fields store "iv:cipher" (no Mongoose getter).
 */
function resolveClientPassphrase(client, decryptFn) {
  const raw = client && client.passphrase != null ? String(client.passphrase) : '';
  if (!raw) return '';
  if (!raw.includes(':')) return raw;
  const decrypt = decryptFn || require('./encryption').decrypt;
  return String(decrypt(raw) || '');
}

function resolveMerchantKey(client, decryptFn) {
  const raw = client && client.merchant_key != null ? String(client.merchant_key) : '';
  if (!raw || !raw.includes(':')) return raw;
  const decrypt = decryptFn || require('./encryption').decrypt;
  return String(decrypt(raw) || '');
}

function apiPublicBase(env = process.env) {
  const base =
    env.PUBLIC_API_BASE ||
    env.PUBLIC_API_URL ||
    env.API_PUBLIC_URL ||
    env.RENDER_EXTERNAL_URL ||
    'https://khanaconnect.onrender.com';
  return String(base).replace(/\/+$/, '');
}

/**
 * Order ITNs must reach POST {api}/payments/payfast/itn. Use the client's notify_url when it
 * already points there; otherwise (new clients default notify_url to the storefront
 * return_url) use this API's own ITN URL so the order is marked paid.
 */
function resolveOrderNotifyUrl(client, env = process.env) {
  const own = String((client && client.notify_url) || '').trim();
  if (/\/payments\/payfast\/itn\/?$/i.test(own)) return own;
  const apiPath = String(env.API_URL || '/api/v1').replace(/\/+$/, '');
  return `${apiPublicBase(env)}${apiPath}${ORDER_ITN_PATH}`;
}

function formatAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return (Math.round(n * 100) / 100).toFixed(2);
}

function clip(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

/** Optional buyer details from the storefront request (they become part of the signature). */
function sanitizeBuyer(input) {
  const b = input && typeof input === 'object' ? input : {};
  const out = {};
  const first = clip(b.name_first ?? b.firstName, 100);
  const last = clip(b.name_last ?? b.lastName, 100);
  const email = clip(b.email_address ?? b.email, 100);
  const cell = String(b.cell_number ?? b.phone ?? '').replace(/[^\d]/g, '');
  if (first) out.name_first = first;
  if (last) out.name_last = last;
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) out.email_address = email;
  // PayFast only accepts 10-digit SA cell numbers starting with 0.
  if (/^0\d{9}$/.test(cell)) out.cell_number = cell;
  return out;
}

/** Host and process URL, honouring PAYFAST_SANDBOX via helpers/payfast.js. */
function payfastProcessTarget(hostFn) {
  const host = (hostFn || require('./payfast').payfastHost)();
  return { host, action: `https://${host}/eng/process` };
}

function buildOrderCheckoutFields({ client, order, buyer, decryptFn, env }) {
  const amount = formatAmount(order.finalPrice);
  const ref = String(order.orderNumber || '').trim() || String(order._id);
  const company = String(client.companyName || '').trim();
  return {
    merchant_id: client.merchant_id,
    merchant_key: resolveMerchantKey(client, decryptFn),
    return_url: client.return_url,
    cancel_url: client.cancel_url || client.return_url,
    notify_url: resolveOrderNotifyUrl(client, env),
    ...sanitizeBuyer(buyer),
    m_payment_id: String(order._id),
    amount,
    item_name: clip(company ? `${company} order ${ref}` : `Order ${ref}`, 100),
    custom_str1: client.clientID,
    custom_str2: 'order',
  };
}

function buildBookingCheckoutFields({ client, booking, buyer, decryptFn }) {
  const amount = formatAmount(booking.payment && booking.payment.depositAmount);
  const company = String(client.companyName || '').trim();
  const services = Array.isArray(booking.services) ? booking.services.filter(Boolean).join(', ') : '';
  const fallbackBuyer = {};
  const name = String(booking.customerName || '').trim();
  if (name) {
    const parts = name.split(/\s+/);
    fallbackBuyer.name_first = parts.shift();
    if (parts.length) fallbackBuyer.name_last = parts.join(' ');
  }
  if (booking.customerEmail) fallbackBuyer.email_address = booking.customerEmail;
  return {
    merchant_id: client.merchant_id,
    merchant_key: resolveMerchantKey(client, decryptFn),
    return_url: client.return_url,
    cancel_url: client.cancel_url || client.return_url,
    // No PayFast-format booking ITN exists in this API yet; keep the client's own notify_url
    // (what storefronts sent before) so whatever handles booking deposits today still gets it.
    notify_url: client.notify_url || '',
    ...sanitizeBuyer({ ...fallbackBuyer, ...(buyer || {}) }),
    m_payment_id: String(booking._id),
    amount,
    item_name: clip(`${company ? `${company} ` : ''}booking deposit`, 100),
    item_description: clip(services, 255),
    custom_str1: client.clientID,
    custom_str2: 'booking',
  };
}

function isObjectIdLike(id) {
  return /^[a-f0-9]{24}$/i.test(String(id || ''));
}

/** Token types allowed to start a checkout: storefront API token or a shopper token. */
function checkoutCallerAllowed(session) {
  if (!session || !session.client) return false;
  return !!(session.isApiToken || session.isCustomerToken || session.member || session.platformAdmin);
}

/**
 * Build a signed PayFast checkout for one order of the caller's business.
 * @returns {Promise<{status:number, body:object}>}
 */
async function prepareOrderCheckout({ session, decoded, orderId, buyer, deps }) {
  const { Order, payfastHost, decryptFn, env } = deps;
  if (!checkoutCallerAllowed(session)) {
    return { status: 403, body: { success: false, error: 'Storefront or customer token required' } };
  }
  if (!isObjectIdLike(orderId)) {
    return { status: 400, body: { success: false, error: 'orderId must be a 24-character order id' } };
  }

  const client = session.client;
  const order = await Order.findOne({ _id: String(orderId), clientID: client.clientID, deletedAt: null });
  if (!order) return { status: 404, body: { success: false, error: 'Order not found' } };

  // Shoppers can only pay their own orders.
  const customerId = decoded && (decoded.customerID || decoded.customerId);
  if (session.isCustomerToken && order.customer && customerId && String(order.customer) !== String(customerId)) {
    return { status: 404, body: { success: false, error: 'Order not found' } };
  }
  if (order.paid) return { status: 409, body: { success: false, error: 'Order is already paid', code: 'ALREADY_PAID' } };
  if (order.refunded) return { status: 409, body: { success: false, error: 'Order was refunded', code: 'REFUNDED' } };

  return finishCheckout({
    client,
    fields: buildOrderCheckoutFields({ client, order, buyer, decryptFn, env }),
    kind: 'order',
    id: String(order._id),
    payfastHost,
    decryptFn,
  });
}

/** Build a signed PayFast checkout for a booking deposit (booking.payment.depositAmount). */
async function prepareBookingCheckout({ session, bookingId, buyer, deps }) {
  const { Booking, payfastHost, decryptFn } = deps;
  if (!checkoutCallerAllowed(session)) {
    return { status: 403, body: { success: false, error: 'Storefront or customer token required' } };
  }
  if (!isObjectIdLike(bookingId)) {
    return { status: 400, body: { success: false, error: 'bookingId must be a 24-character booking id' } };
  }

  const client = session.client;
  const booking = await Booking.findOne({ _id: String(bookingId), clientID: client.clientID });
  if (!booking) return { status: 404, body: { success: false, error: 'Booking not found' } };

  const payStatus = booking.payment && booking.payment.status;
  if (payStatus === 'paid' || payStatus === 'deposit-paid') {
    return { status: 409, body: { success: false, error: 'Booking deposit is already paid', code: 'ALREADY_PAID' } };
  }
  if (booking.status === 'cancelled') {
    return { status: 409, body: { success: false, error: 'Booking is cancelled', code: 'CANCELLED' } };
  }

  return finishCheckout({
    client,
    fields: buildBookingCheckoutFields({ client, booking, buyer, decryptFn }),
    kind: 'booking',
    id: String(booking._id),
    payfastHost,
    decryptFn,
  });
}

function finishCheckout({ client, fields, kind, id, payfastHost, decryptFn }) {
  if (!fields.amount) {
    return {
      status: 409,
      body: {
        success: false,
        error: kind === 'booking' ? 'Booking has no deposit amount to pay' : 'Order total must be more than zero',
        code: 'NO_AMOUNT',
      },
    };
  }
  if (!fields.merchant_id || !fields.merchant_key || !fields.return_url) {
    return {
      status: 409,
      body: { success: false, error: 'PayFast is not set up for this business', code: 'PAYFAST_NOT_CONFIGURED' },
    };
  }

  const signed = signPayfastFields(fields, resolveClientPassphrase(client, decryptFn));
  const target = payfastProcessTarget(payfastHost);
  return {
    status: 200,
    body: {
      success: true,
      kind,
      id,
      method: 'POST',
      action: target.action,
      host: target.host,
      fields: signed,
    },
  };
}

module.exports = {
  PAYFAST_FIELD_ORDER,
  payfastEncode,
  orderedPayfastFields,
  payfastSignatureString,
  signPayfastFields,
  resolveClientPassphrase,
  resolveOrderNotifyUrl,
  sanitizeBuyer,
  formatAmount,
  buildOrderCheckoutFields,
  buildBookingCheckoutFields,
  checkoutCallerAllowed,
  prepareOrderCheckout,
  prepareBookingCheckout,
};
