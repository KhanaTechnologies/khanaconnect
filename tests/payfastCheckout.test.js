/**
 * Offline tests for server-side PayFast checkout signing and passphrase stripping.
 * No database, no network, no test runner:  node tests/payfastCheckout.test.js
 *
 * express, mongoose, the models and the PayFast network helper are stubbed so the real
 * routes/payments.js handlers run against in-memory fakes.
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const Module = require('module');

// helpers/encryption.js exits the process without a valid key; use a throwaway one.
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
delete process.env.PAYFAST_SANDBOX;
delete process.env.PAYFAST_LEGACY_STOREFRONT_PASSPHRASE;
process.env.PUBLIC_API_BASE = 'https://api.example.test/';
process.env.API_URL = '/api/v1';

const ROOT = path.join(__dirname, '..');
const abs = (p) => path.join(ROOT, p);

// ---------------------------------------------------------------- in-memory fakes
const db = { orders: [], bookings: [], clients: [] };

function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (v === null) return doc[k] == null;
    return String(doc[k]) === String(v);
  });
}

const fakeOrderModel = {
  async findOne(filter) {
    return db.orders.find((o) => matches(o, filter)) || null;
  },
};
const fakeBookingModel = {
  async findOne(filter) {
    return db.bookings.find((b) => matches(b, filter)) || null;
  },
};
const fakeClientModel = {
  async findOne(filter) {
    return db.clients.find((c) => matches(c, filter)) || null;
  },
};

const calls = { validate: 0, fulfilled: [] };
const sessions = new Map(); // token kind → session

const routes = {};
const stubs = {
  express: {
    Router() {
      return {
        post(p, handler) {
          routes[`POST ${p}`] = handler;
        },
        get(p, handler) {
          routes[`GET ${p}`] = handler;
        },
      };
    },
  },
  mongoose: { Types: { ObjectId: { isValid: (id) => /^[a-f0-9]{24}$/i.test(String(id)) } } },
  [abs('helpers/failureEmail.js')]: { wrapRoute: (fn) => fn },
  [abs('helpers/payfast.js')]: {
    payfastHost: () => (process.env.PAYFAST_SANDBOX === 'true' ? 'sandbox.payfast.co.za' : 'www.payfast.co.za'),
    async validateItnWithPayfast() {
      calls.validate += 1;
      return true;
    },
  },
  [abs('helpers/fulfillGatewayPayment.js')]: {
    async fulfillGatewayPayment(orderId, amount) {
      calls.fulfilled.push({ orderId: String(orderId), amount: String(amount) });
      return { ok: true };
    },
  },
  [abs('helpers/teamAuth.js')]: {
    async resolveSessionFromToken(decoded) {
      return sessions.get(decoded.kind) || null;
    },
  },
  [abs('models/client.js')]: fakeClientModel,
  [abs('models/order.js')]: { Order: fakeOrderModel },
  [abs('models/booking.js')]: fakeBookingModel,
};

const realLoad = Module._load;
Module._load = function stubbedLoad(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  if (parent && request.startsWith('.')) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (Object.prototype.hasOwnProperty.call(stubs, resolved)) return stubs[resolved];
  }
  return realLoad.apply(this, arguments);
};

const checkout = require('../helpers/payfastCheckout');
const { stripClientSecrets, payfastPassphraseAccess } = require('../helpers/publicClientPayload');
const { encrypt } = require('../helpers/encryption');
require('../routes/payments');

// ---------------------------------------------------------------- helpers
function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
  };
}

async function call(route, { auth, body }) {
  const res = fakeRes();
  await routes[route]({ auth, body }, res);
  return res;
}

/** Independent re-implementation of the PayFast checkout signature, for cross-checking. */
function expectedSignature(fields, passphrase) {
  const enc = (v) =>
    encodeURIComponent(String(v).trim())
      .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
      .replace(/%20/g, '+');
  const parts = Object.keys(fields)
    .filter((k) => k !== 'signature')
    .map((k) => `${k}=${enc(fields[k])}`);
  if (passphrase) parts.push(`passphrase=${enc(passphrase)}`);
  return crypto.createHash('md5').update(parts.join('&')).digest('hex');
}

let passed = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------- fixtures
const PASSPHRASE = 'Jo Burg salt!(2026)';
const shop = {
  clientID: 'shop1',
  companyName: 'Shop One',
  merchant_id: 10000100,
  merchant_key: '46f0cd694581a',
  passphrase: encrypt(PASSPHRASE), // stored encrypted, as after the merchant-field migration
  return_url: 'https://shopone.example/checkout/success',
  cancel_url: 'https://shopone.example/checkout/cancel',
  notify_url: 'https://shopone.example', // default from clientCreate: storefront URL, not the ITN
};
const other = { ...shop, clientID: 'shop2', merchant_id: 10000200, passphrase: 'plainpass' };
db.clients.push(shop, other);

const ORDER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const PAID_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ZERO_ID = 'cccccccccccccccccccccccc';
const OTHER_SHOP_ORDER = 'dddddddddddddddddddddddd';
const CUSTOMER_A = '111111111111111111111111';
const CUSTOMER_B = '222222222222222222222222';
db.orders.push(
  { _id: ORDER_ID, clientID: 'shop1', finalPrice: 349.9, orderNumber: 'KC-1001', paid: false, deletedAt: null, customer: CUSTOMER_A },
  { _id: PAID_ID, clientID: 'shop1', finalPrice: 100, paid: true, deletedAt: null },
  { _id: ZERO_ID, clientID: 'shop1', finalPrice: 0, paid: false, deletedAt: null },
  { _id: OTHER_SHOP_ORDER, clientID: 'shop2', finalPrice: 50, paid: false, deletedAt: null }
);

const BOOKING_ID = 'eeeeeeeeeeeeeeeeeeeeeeee';
const BOOKING_PAID = 'ffffffffffffffffffffffff';
const BOOKING_NO_DEPOSIT = '999999999999999999999999';
db.bookings.push(
  {
    _id: BOOKING_ID,
    clientID: 'shop1',
    status: 'pending',
    customerName: 'Thandi van der Merwe',
    customerEmail: 'thandi@example.com',
    services: ['Cut', 'Colour'],
    payment: { status: 'pending', depositAmount: 200 },
  },
  { _id: BOOKING_PAID, clientID: 'shop1', status: 'confirmed', payment: { status: 'deposit-paid', depositAmount: 200 } },
  { _id: BOOKING_NO_DEPOSIT, clientID: 'shop1', status: 'pending', payment: { status: 'pending' } }
);

sessions.set('storefront', { client: shop, member: null, isApiToken: true });
sessions.set('customerA', { client: shop, member: null, isCustomerToken: true });
sessions.set('customerB', { client: shop, member: null, isCustomerToken: true });
sessions.set('purpose', { client: shop, member: null, isPurposeToken: true });
sessions.set('buyer', { client: shop, member: null, isBuyerToken: true });

const tokens = {
  storefront: { clientID: 'shop1', kind: 'storefront' },
  customerA: { clientID: 'shop1', customerID: CUSTOMER_A, loginType: 'customer', kind: 'customerA' },
  customerB: { clientID: 'shop1', customerID: CUSTOMER_B, loginType: 'customer', kind: 'customerB' },
  purpose: { clientID: 'shop1', purpose: 'x', kind: 'purpose' },
  buyer: { clientID: 'shop1', buyerId: 'b1', kind: 'buyer' },
  unknown: { clientID: 'shop1', kind: 'nobody' },
};

// ---------------------------------------------------------------- signature unit tests
test('encoding matches PHP urlencode (uppercase hex, + for spaces, !\'()*~ encoded)', () => {
  assert.strictEqual(checkout.payfastEncode("a b!'()*~/:&="), 'a+b%21%27%28%29%2A%7E%2F%3A%26%3D');
});

test('signature string uses PayFast field order, skips empties, appends passphrase', () => {
  const ordered = checkout.orderedPayfastFields({
    amount: '10.00',
    item_name: ' Test Item ',
    merchant_key: '46f0cd694581a',
    merchant_id: '10000100',
    email_address: '',
    unknown_field: 'dropped',
  });
  assert.deepStrictEqual(Object.keys(ordered), ['merchant_id', 'merchant_key', 'amount', 'item_name']);
  assert.strictEqual(
    checkout.payfastSignatureString(ordered, 'my pass'),
    'merchant_id=10000100&merchant_key=46f0cd694581a&amount=10.00&item_name=Test+Item&passphrase=my+pass'
  );
  const signed = checkout.signPayfastFields(ordered, 'my pass');
  assert.strictEqual(
    signed.signature,
    crypto
      .createHash('md5')
      .update('merchant_id=10000100&merchant_key=46f0cd694581a&amount=10.00&item_name=Test+Item&passphrase=my+pass')
      .digest('hex')
  );
  // No passphrase → nothing appended.
  assert.strictEqual(checkout.payfastSignatureString(ordered, ''), 'merchant_id=10000100&merchant_key=46f0cd694581a&amount=10.00&item_name=Test+Item');
});

test('passphrase resolves from plain and encrypted storage', () => {
  assert.strictEqual(checkout.resolveClientPassphrase({ passphrase: 'plainpass' }), 'plainpass');
  assert.strictEqual(checkout.resolveClientPassphrase({ passphrase: encrypt(PASSPHRASE) }), PASSPHRASE);
  assert.strictEqual(checkout.resolveClientPassphrase({}), '');
});

test('notify_url: client ITN URL kept, otherwise API order ITN URL', () => {
  assert.strictEqual(
    checkout.resolveOrderNotifyUrl({ notify_url: 'https://khanaconnect.onrender.com/api/v1/payments/payfast/itn' }),
    'https://khanaconnect.onrender.com/api/v1/payments/payfast/itn'
  );
  assert.strictEqual(
    checkout.resolveOrderNotifyUrl({ notify_url: 'https://shopone.example' }),
    'https://api.example.test/api/v1/payments/payfast/itn'
  );
});

test('buyer details are sanitised', () => {
  assert.deepStrictEqual(
    checkout.sanitizeBuyer({ name_first: ' Sipho ', email_address: 'not-an-email', cell_number: '082 123 4567', junk: 'x' }),
    { name_first: 'Sipho', cell_number: '0821234567' }
  );
  assert.deepStrictEqual(checkout.sanitizeBuyer({ cell_number: '+27821234567' }), {});
});

test('amount formatting', () => {
  assert.strictEqual(checkout.formatAmount(349.9), '349.90');
  assert.strictEqual(checkout.formatAmount('1200'), '1200.00');
  assert.strictEqual(checkout.formatAmount(0), null);
  assert.strictEqual(checkout.formatAmount(-5), null);
  assert.strictEqual(checkout.formatAmount('abc'), null);
});

// ---------------------------------------------------------------- order checkout route
test('storefront token gets signed order checkout; passphrase never in response', async () => {
  const res = await call('POST /payfast/checkout', {
    auth: tokens.storefront,
    body: { orderId: ORDER_ID, buyer: { name_first: 'Sipho', email_address: 'sipho@example.com' } },
  });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  const b = res.body;
  assert.strictEqual(b.success, true);
  assert.strictEqual(b.kind, 'order');
  assert.strictEqual(b.method, 'POST');
  assert.strictEqual(b.host, 'www.payfast.co.za');
  assert.strictEqual(b.action, 'https://www.payfast.co.za/eng/process');
  assert.deepStrictEqual(Object.keys(b.fields), [
    'merchant_id', 'merchant_key', 'return_url', 'cancel_url', 'notify_url',
    'name_first', 'email_address', 'm_payment_id', 'amount', 'item_name',
    'custom_str1', 'custom_str2', 'signature',
  ]);
  assert.strictEqual(b.fields.merchant_id, '10000100');
  assert.strictEqual(b.fields.merchant_key, '46f0cd694581a');
  assert.strictEqual(b.fields.m_payment_id, ORDER_ID);
  assert.strictEqual(b.fields.amount, '349.90');
  assert.strictEqual(b.fields.item_name, 'Shop One order KC-1001');
  assert.strictEqual(b.fields.return_url, shop.return_url);
  assert.strictEqual(b.fields.cancel_url, shop.cancel_url);
  assert.strictEqual(b.fields.notify_url, 'https://api.example.test/api/v1/payments/payfast/itn');
  assert.strictEqual(b.fields.signature, expectedSignature(b.fields, PASSPHRASE));
  assert.notStrictEqual(b.fields.signature, expectedSignature(b.fields, ''), 'passphrase must be part of signature');
  const raw = JSON.stringify(b);
  assert.ok(!raw.includes(PASSPHRASE) && !raw.includes('passphrase'), 'passphrase leaked');
});

test('PAYFAST_SANDBOX=true points the form at the sandbox host', async () => {
  process.env.PAYFAST_SANDBOX = 'true';
  try {
    const res = await call('POST /payfast/checkout', { auth: tokens.storefront, body: { orderId: ORDER_ID } });
    assert.strictEqual(res.body.action, 'https://sandbox.payfast.co.za/eng/process');
  } finally {
    delete process.env.PAYFAST_SANDBOX;
  }
});

test('ITN for the signed checkout still matches m_payment_id and amount', async () => {
  const { body } = await call('POST /payfast/checkout', { auth: tokens.storefront, body: { orderId: ORDER_ID } });
  calls.fulfilled.length = 0;
  const itn = {
    merchant_id: body.fields.merchant_id,
    m_payment_id: body.fields.m_payment_id,
    amount_gross: body.fields.amount,
    payment_status: 'COMPLETE',
    pf_payment_id: '1089250',
  };
  const res = await call('POST /payfast/itn', { body: itn });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(calls.fulfilled, [{ orderId: ORDER_ID, amount: '349.90' }]);

  // Tampered amount is refused.
  calls.fulfilled.length = 0;
  await call('POST /payfast/itn', { body: { ...itn, amount_gross: '10.00' } });
  assert.deepStrictEqual(calls.fulfilled, []);
});

test('shopper can pay own order, not another shopper\'s', async () => {
  const own = await call('POST /payfast/checkout', { auth: tokens.customerA, body: { orderId: ORDER_ID } });
  assert.strictEqual(own.statusCode, 200);
  const notOwn = await call('POST /payfast/checkout', { auth: tokens.customerB, body: { orderId: ORDER_ID } });
  assert.strictEqual(notOwn.statusCode, 404);
});

test('other business\'s order is not found', async () => {
  const res = await call('POST /payfast/checkout', { auth: tokens.storefront, body: { orderId: OTHER_SHOP_ORDER } });
  assert.strictEqual(res.statusCode, 404);
});

test('paid, zero-total, malformed id, and wrong token types are refused', async () => {
  assert.strictEqual((await call('POST /payfast/checkout', { auth: tokens.storefront, body: { orderId: PAID_ID } })).statusCode, 409);
  assert.strictEqual((await call('POST /payfast/checkout', { auth: tokens.storefront, body: { orderId: ZERO_ID } })).statusCode, 409);
  assert.strictEqual((await call('POST /payfast/checkout', { auth: tokens.storefront, body: { orderId: 'nope' } })).statusCode, 400);
  assert.strictEqual((await call('POST /payfast/checkout', { auth: tokens.storefront, body: {} })).statusCode, 400);
  assert.strictEqual((await call('POST /payfast/checkout', { auth: tokens.purpose, body: { orderId: ORDER_ID } })).statusCode, 403);
  assert.strictEqual((await call('POST /payfast/checkout', { auth: tokens.buyer, body: { orderId: ORDER_ID } })).statusCode, 403);
  assert.strictEqual((await call('POST /payfast/checkout', { auth: tokens.unknown, body: { orderId: ORDER_ID } })).statusCode, 401);
  assert.strictEqual((await call('POST /payfast/checkout', { auth: undefined, body: { orderId: ORDER_ID } })).statusCode, 401);
});

test('missing PayFast setup is reported, not signed', async () => {
  const bare = { ...shop, clientID: 'shop3', merchant_key: '' };
  sessions.set('bare', { client: bare, member: null, isApiToken: true });
  db.orders.push({ _id: '333333333333333333333333', clientID: 'shop3', finalPrice: 10, paid: false, deletedAt: null });
  const res = await call('POST /payfast/checkout', { auth: { clientID: 'shop3', kind: 'bare' }, body: { orderId: '333333333333333333333333' } });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, 'PAYFAST_NOT_CONFIGURED');
});

// ---------------------------------------------------------------- booking deposit route
test('booking deposit checkout is signed from the booking record', async () => {
  const res = await call('POST /payfast/checkout/booking', { auth: tokens.storefront, body: { bookingId: BOOKING_ID } });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  const f = res.body.fields;
  assert.strictEqual(res.body.kind, 'booking');
  assert.strictEqual(f.m_payment_id, BOOKING_ID);
  assert.strictEqual(f.amount, '200.00');
  assert.strictEqual(f.name_first, 'Thandi');
  assert.strictEqual(f.name_last, 'van der Merwe');
  assert.strictEqual(f.email_address, 'thandi@example.com');
  assert.strictEqual(f.item_description, 'Cut, Colour');
  assert.strictEqual(f.custom_str2, 'booking');
  assert.strictEqual(f.notify_url, shop.notify_url);
  assert.strictEqual(f.signature, expectedSignature(f, PASSPHRASE));
  assert.ok(!JSON.stringify(res.body).includes('passphrase'));
});

test('booking: paid, no deposit, other business refused', async () => {
  assert.strictEqual((await call('POST /payfast/checkout/booking', { auth: tokens.storefront, body: { bookingId: BOOKING_PAID } })).statusCode, 409);
  const none = await call('POST /payfast/checkout/booking', { auth: tokens.storefront, body: { bookingId: BOOKING_NO_DEPOSIT } });
  assert.strictEqual(none.statusCode, 409);
  assert.strictEqual(none.body.code, 'NO_AMOUNT');
  sessions.set('storefront2', { client: other, member: null, isApiToken: true });
  assert.strictEqual(
    (await call('POST /payfast/checkout/booking', { auth: { clientID: 'shop2', kind: 'storefront2' }, body: { bookingId: BOOKING_ID } })).statusCode,
    404
  );
});

// ---------------------------------------------------------------- passphrase stripping
test('stripClientSecrets drops passphrase by default, keeps merchant_key', () => {
  const out = stripClientSecrets({ clientID: 'x', merchant_key: 'k', passphrase: 'p', password: 'h', token: 't' });
  assert.strictEqual(out.passphrase, undefined);
  assert.strictEqual(out.password, undefined);
  assert.strictEqual(out.token, undefined);
  assert.strictEqual(out.merchant_key, 'k');
  assert.strictEqual(stripClientSecrets({ passphrase: 'p' }, { includePayfastPassphrase: true }).passphrase, 'p');
});

test('passphrase access matrix', () => {
  const env = {};
  const owner = { client: shop, member: { _id: 'm' }, orgRole: 'owner' };
  const manager = { client: shop, member: { _id: 'm' }, orgRole: 'manager' };
  const admin = { client: shop, member: { _id: 'm' }, orgRole: 'admin' };
  const platform = { client: shop, member: { _id: 'm' }, orgRole: 'owner', platformAdmin: true };
  assert.deepStrictEqual(payfastPassphraseAccess(owner, env), { include: true, legacy: false });
  assert.deepStrictEqual(payfastPassphraseAccess(platform, env), { include: true, legacy: false });
  assert.deepStrictEqual(payfastPassphraseAccess(manager, env), { include: false, legacy: false });
  assert.deepStrictEqual(payfastPassphraseAccess(admin, env), { include: false, legacy: false });
  assert.deepStrictEqual(payfastPassphraseAccess(sessions.get('customerA'), env), { include: false, legacy: false });
  assert.deepStrictEqual(payfastPassphraseAccess(sessions.get('buyer'), env), { include: false, legacy: false });
  assert.deepStrictEqual(payfastPassphraseAccess(sessions.get('purpose'), env), { include: false, legacy: false });
  assert.deepStrictEqual(payfastPassphraseAccess(null, env), { include: false, legacy: false });
  // Storefront token: legacy fallback until the switch is turned off.
  assert.deepStrictEqual(payfastPassphraseAccess(sessions.get('storefront'), env), { include: true, legacy: true });
  assert.deepStrictEqual(
    payfastPassphraseAccess(sessions.get('storefront'), { PAYFAST_LEGACY_STOREFRONT_PASSPHRASE: 'false' }),
    { include: false, legacy: false }
  );
  assert.deepStrictEqual(
    payfastPassphraseAccess(sessions.get('storefront'), { PAYFAST_LEGACY_STOREFRONT_PASSPHRASE: 'FALSE' }),
    { include: false, legacy: false }
  );
});

// ---------------------------------------------------------------- run
(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`ok   ${t.name}`);
    } catch (err) {
      console.error(`FAIL ${t.name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n     ') : err}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
