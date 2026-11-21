/**
 * Offline tests for the public storefront API (routes/storefront.js helpers + auth).
 * No database, no network, no test runner:  node tests/storefrontApi.test.js
 *
 * Also checks that what the handlers return matches the Storefront* schemas in
 * config/openapi.js, so the schemas the boilerplate is generated from tell the truth.
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const abs = (p) => path.join(ROOT, p);

// bcryptjs / jsonwebtoken / the Client model are stubbed (no node_modules or mongoose needed).
const fakeClients = [];
const stubs = {
  bcryptjs: { hashSync: () => 'hashed' },
  jsonwebtoken: {},
  [abs('models/client.js')]: {
    findOne(filter) {
      const doc = fakeClients.find((c) => c.clientID === filter.clientID) || null;
      return { select: async () => doc };
    },
  },
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

const sc = require('../helpers/storefrontCatalog');
const { createStorefrontAuth } = require('../helpers/storefrontAuth');
const { validate } = require('../boilerplate/scripts/openapi-contract.cjs');
const { spec } = require('../config/openapi');

const comps = spec().components.schemas;
function assertSchema(value, name) {
  const errs = validate(value, { $ref: `#/components/schemas/${name}` }, comps);
  assert.deepStrictEqual(errs, [], `${name} does not match config/openapi.js:\n  ${errs.join('\n  ')}`);
}

// ---------------------------------------------------------------- fakes
let seq = 0;
const oid = () => (++seq).toString(16).padStart(24, '0');

function makeDb() {
  const db = { products: [], customers: [], orders: [], items: [], stockCalls: [] };
  class Doc {
    constructor(data) {
      Object.assign(this, data);
      this._id = this._id || oid();
    }
  }
  class Customer extends Doc {
    async save() {
      if (!db.customers.includes(this)) db.customers.push(this);
      return this;
    }
    static async findOne(f) {
      return db.customers.find((c) => String(c._id) === String(f._id) && c.clientID === f.clientID) || null;
    }
  }
  class OrderItem extends Doc {
    async save() {
      db.items.push(this);
      return this;
    }
  }
  class Order extends Doc {
    async save() {
      if (!db.orders.includes(this)) db.orders.push(this);
      return this;
    }
  }
  const Product = {
    async findOne(f) {
      return db.products.find((p) => String(p._id) === String(f._id) && p.clientID === f.clientID) || null;
    },
  };
  const deps = {
    Product,
    Customer,
    Order,
    OrderItem,
    async findCustomerByEmail(_M, clientID, email) {
      return db.customers.find((c) => c.clientID === clientID && c.emailAddress === email) || null;
    },
    async deductLineStock(args) {
      db.stockCalls.push(args);
    },
  };
  return { db, deps };
}

const client = {
  clientID: 'shop1',
  companyName: 'Shop One',
  deliveryOptions: [
    { type: 'Courier', price: 99.5 },
    { type: 'collection', price: 0 },
  ],
  whatsapp: { enabled: true, phoneE164: '27821234567' },
};

function product(extra = {}) {
  return {
    _id: oid(),
    clientID: 'shop1',
    productName: 'Candle',
    description: 'Soy candle',
    price: 200,
    salePercentage: 10,
    countInStock: 5,
    images: ['https://img/1.png'],
    category: { _id: oid(), name: 'Home' },
    status: 'published',
    variants: [{ name: 'Size', values: [{ value: 'Large', price: 300, stock: 1 }] }],
    ...extra,
  };
}

const order = (body) => ({
  customer: { firstName: 'Sipho', lastName: 'Dlamini', email: 'Sipho@Example.com ', phone: '0821234567' },
  shipping: { address: '1 Main Rd', city: 'Pretoria', postalCode: '0181' },
  deliveryType: 'Courier',
  ...body,
});

// ---------------------------------------------------------------- tests
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('siteInfo matches StorefrontSite and exposes no secrets', () => {
  const site = sc.siteInfo({ ...client, passphrase: 'secret', merchant_key: 'k', token: 't' });
  assertSchema(site, 'StorefrontSite');
  assert.strictEqual(site.whatsappChatUrl.startsWith('https://wa.me/27821234567'), true);
  assert(!JSON.stringify(site).includes('secret'));
});

test('storefrontProduct applies the sale, hides cost price, matches StorefrontProduct', () => {
  const p = sc.storefrontProduct(product({ costPrice: 50 }));
  assertSchema(p, 'StorefrontProduct');
  assert.strictEqual(p.unitPrice, 180);
  assert.strictEqual(p.variants[0].values[0].unitPrice, 270);
  assert.strictEqual('costPrice' in p, false);
  assert.strictEqual('stock' in p.variants[0].values[0], false);
});

test('storefrontCategory matches StorefrontCategory', () => {
  assertSchema(sc.storefrontCategory({ _id: oid(), name: 'Home', parentId: null }), 'StorefrontCategory');
});

test('guest checkout prices from the catalogue, adds delivery, reserves stock', async () => {
  const { db, deps } = makeDb();
  const p = product();
  db.products.push(p);
  const { order: o } = await sc.createStorefrontOrder({
    clientId: 'shop1',
    client,
    body: order({ items: [{ productId: p._id, quantity: 2, price: 1 }, { productId: p._id, quantity: 1, variant: { name: 'Size', value: 'Large' } }] }),
    deps,
  });
  assert.strictEqual(o.totalPrice, 630); // 2 × 180 + 270, the request's price ignored
  assert.strictEqual(o.deliveryPrice, 99.5);
  assert.strictEqual(o.finalPrice, 729.5);
  assert.strictEqual(o.paid, false);
  assert.strictEqual(o.stockDeducted, true);
  assert.strictEqual(db.stockCalls.length, 2);
  assert.strictEqual(db.customers.length, 1);
  assert.strictEqual(db.customers[0].emailAddress, 'sipho@example.com');

  // Populate like the route does, then check the public shape.
  o.orderItems = db.items.map((it) => ({ ...it, product: p }));
  const pub = sc.storefrontOrder(o);
  assertSchema(pub, 'StorefrontOrder');
  assert.strictEqual(pub.items[0].lineTotal, 360);
  assert(!JSON.stringify(pub).includes('1 Main Rd'), 'no address in the public order');
  assert(!JSON.stringify(pub).includes('0821234567'), 'no phone in the public order');
});

test('second order with the same email reuses the guest customer', async () => {
  const { db, deps } = makeDb();
  const p = product();
  db.products.push(p);
  const body = order({ items: [{ productId: p._id, quantity: 1 }] });
  await sc.createStorefrontOrder({ clientId: 'shop1', client, body, deps });
  await sc.createStorefrontOrder({ clientId: 'shop1', client, body, deps });
  assert.strictEqual(db.customers.length, 1);
  assert.strictEqual(db.orders.length, 2);
});

async function rejects(body, status, re, setup) {
  const { db, deps } = makeDb();
  const p = product();
  db.products.push(p);
  if (setup) setup(db, p);
  const b = typeof body === 'function' ? body(p) : body;
  await assert.rejects(
    sc.createStorefrontOrder({ clientId: 'shop1', client, body: b, deps }),
    (err) => err.status === status && re.test(`${err.message} ${err.code || ''}`)
  );
  assert.strictEqual(db.orders.length, 0, 'nothing written on a rejected order');
}

test('rejects: unknown delivery type, draft product, other client, out of stock, bad variant, bad input', async () => {
  await rejects((p) => order({ deliveryType: 'Drone', items: [{ productId: p._id, quantity: 1 }] }), 400, /Courier/);
  await rejects((p) => order({ items: [{ productId: p._id, quantity: 1 }] }), 400, /PRODUCT_UNAVAILABLE/, (_db, p) => {
    p.status = 'draft';
  });
  await rejects((p) => order({ items: [{ productId: p._id, quantity: 1 }] }), 400, /PRODUCT_UNAVAILABLE/, (_db, p) => {
    p.clientID = 'shop2';
  });
  await rejects((p) => order({ items: [{ productId: p._id, quantity: 6 }] }), 409, /OUT_OF_STOCK/);
  await rejects((p) => order({ items: [{ productId: p._id, quantity: 2, variant: { name: 'Size', value: 'Large' } }] }), 409, /OUT_OF_STOCK/);
  await rejects((p) => order({ items: [{ productId: p._id, quantity: 1, variant: { name: 'Size', value: 'XL' } }] }), 400, /UNKNOWN_VARIANT/);
  await rejects((p) => order({ items: [{ productId: p._id, quantity: 0 }] }), 400, /quantity/);
  await rejects(order({ items: [{ productId: 'nope', quantity: 1 }] }), 400, /productId/);
  await rejects(order({ items: [] }), 400, /items/);
  await rejects((p) => order({ customer: { firstName: 'A', lastName: 'B', email: 'bad', phone: '1' }, items: [{ productId: p._id, quantity: 1 }] }), 400, /email/);
  await rejects((p) => order({ shipping: {}, items: [{ productId: p._id, quantity: 1 }] }), 400, /address/);
});

test('collection orders need no address; stores without delivery options only allow collection', async () => {
  const { db, deps } = makeDb();
  const p = product();
  db.products.push(p);
  const bare = { ...client, deliveryOptions: [] };
  const { order: o } = await sc.createStorefrontOrder({
    clientId: 'shop1',
    client: bare,
    body: order({ deliveryType: 'collection', shipping: {}, items: [{ productId: p._id, quantity: 1 }] }),
    deps,
  });
  assert.strictEqual(o.deliveryPrice, 0);
  assert.strictEqual(o.address, 'Collection');
  await assert.rejects(
    sc.createStorefrontOrder({ clientId: 'shop1', client: bare, body: order({ items: [{ productId: p._id, quantity: 1 }] }), deps }),
    /collection/
  );
});

// ---------------------------------------------------------------- auth
function runAuth(decoded, clientDoc = client) {
  fakeClients.length = 0;
  if (clientDoc) fakeClients.push({ ...clientDoc, subscription: { status: 'active', paidUntil: new Date(Date.now() + 864e5) } });
  const auth = createStorefrontAuth({
    verify: () => {
      if (decoded instanceof Error) throw decoded;
      return { decoded };
    },
  });
  const req = { headers: { authorization: 'Bearer x' } };
  const res = {
    statusCode: 200,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  let nexted = false;
  return auth(req, res, () => {
    nexted = true;
  }).then(() => ({ req, res, nexted }));
}

test('storefrontAuth: storefront and shopper tokens pass; purpose, B2B and bad tokens do not', async () => {
  let r = await runAuth({ clientID: 'shop1', role: 'client' });
  assert(r.nexted && r.req.clientId === 'shop1' && r.req.storefrontCustomerId === '');
  r = await runAuth({ clientID: 'shop1', customerID: 'c1', loginType: 'customer' });
  assert(r.nexted && r.req.storefrontCustomerId === 'c1');
  for (const bad of [{ clientID: 'shop1', purpose: 'reset' }, { clientID: 'shop1', buyerId: 'b' }, { clientID: 'shop1', role: 'b2b' }, {}]) {
    r = await runAuth(bad);
    assert(!r.nexted && r.res.statusCode === 403, JSON.stringify(bad));
  }
  r = await runAuth(new Error('jwt malformed'));
  assert(!r.nexted && r.res.statusCode === 401);
  r = await runAuth({ clientID: 'ghost' }, null);
  assert(!r.nexted && r.res.statusCode === 404);
});

test('storefrontAuth: inactive subscription gets 402', async () => {
  fakeClients.length = 0;
  fakeClients.push({ ...client, subscription: { status: 'suspended' } });
  const auth = createStorefrontAuth({ verify: () => ({ decoded: { clientID: 'shop1' } }) });
  const res = { status(c) { this.statusCode = c; return this; }, json() { return this; } };
  let nexted = false;
  await auth({ headers: { authorization: 'Bearer x' } }, res, () => { nexted = true; });
  assert(!nexted && res.statusCode === 402);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✔ ${t.name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✖ ${t.name}\n    ${err.stack || err}`);
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
