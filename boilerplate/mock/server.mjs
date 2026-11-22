#!/usr/bin/env node
/**
 * Mock khanaconnect storefront API for front-end work and demos (no database, no PayFast).
 *
 *   npm run dev:mock      → http://localhost:4010/api/v1   (any non-empty Bearer token works)
 *
 * Every response is checked against src/api/generated/contract.snapshot.json, so the mock
 * can't quietly drift from the real API: if the API's schemas change and you regenerate,
 * a stale mock answer fails loudly here.
 *
 * PayFast is simulated: checkout returns a form that posts to /_payfast/process on this
 * server, which marks the order paid (like the real ITN) and redirects to the site's
 * /checkout/success. Use the real API with PAYFAST_SANDBOX=true for a true sandbox payment.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { validate } = require('../scripts/openapi-contract.cjs');
const contract = JSON.parse(readFileSync(path.join(here, '../src/api/generated/contract.snapshot.json'), 'utf8'));
const comps = contract.schemas;

const PORT = Number(process.env.MOCK_PORT || 4010);
const SITE_URL = (process.env.SITE_URL || 'http://localhost:5180').replace(/\/+$/, '');
const API = '/api/v1';
const oid = () => randomBytes(12).toString('hex');

// ------------------------------------------------------------------ seed data
const cat = (name) => ({ id: oid(), name, description: '', image: null, parentId: null });
const categories = [cat('Candles'), cat('Gifts')];
const img = (seed) => `https://picsum.photos/seed/${seed}/600/600`;
function product(name, price, extra = {}) {
  const id = oid();
  const sale = extra.salePercentage || 0;
  const unit = Math.round(price * (1 - sale / 100) * 100) / 100;
  return {
    id,
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    description: `${name}, hand-poured in Pretoria.`,
    richDescription: '',
    price,
    salePercentage: sale,
    unitPrice: unit,
    images: [img(id.slice(0, 6))],
    brand: '',
    category: { id: categories[0].id, name: categories[0].name },
    tags: [],
    isFeatured: false,
    inStock: true,
    stock: 10,
    rating: 0,
    numReviews: 0,
    metaTitle: '',
    metaDescription: '',
    variants: [],
    ...extra,
  };
}
const products = [
  product('Amber Soy Candle', 220, { isFeatured: true }),
  product('Fynbos Candle', 260, {
    isFeatured: true,
    salePercentage: 10,
    variants: [
      {
        name: 'Size',
        values: [
          { value: 'Small', unitPrice: 234, inStock: true },
          { value: 'Large', unitPrice: 360, inStock: true },
        ],
      },
    ],
  }),
  product('Gift Box', 480, { category: { id: categories[1].id, name: categories[1].name }, isFeatured: true }),
  product('Matches Tin', 45, { inStock: false, stock: 0 }),
];
const services = [
  { _id: oid(), name: 'Aromatherapy Massage', description: '60 minutes of calm.', price: 550, duration: 60, category: '', image: '', staffIds: [], bufferBeforeMin: 0, bufferAfterMin: 15 },
  { _id: oid(), name: 'Candle-making Class', description: 'Make two candles to take home.', price: 750, duration: 120, category: '', image: '', staffIds: [], bufferBeforeMin: 0, bufferAfterMin: 0 },
];
const site = {
  clientID: 'demo-client',
  companyName: 'Demo Studio (mock API)',
  currency: 'ZAR',
  deliveryOptions: [
    { type: 'Courier', price: 99 },
    { type: 'collection', price: 0 },
  ],
  whatsappChatUrl: 'https://wa.me/27000000000',
};
const orders = new Map();
const bookings = [];

// ------------------------------------------------------------------ helpers
function send(res, status, body, opId) {
  if (opId && status < 300) {
    const op = contract.operations[opId];
    const errs = validate(body, op.response, comps);
    if (errs.length) {
      console.error(`✖ mock ${opId} response breaks the contract:\n  ${errs.join('\n  ')}`);
      status = 500;
      body = { error: `Mock is out of date with the API contract (${opId}). See the mock server log.` };
    }
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}
const fail = (res, status, error, code) => send(res, status, { error, ...(code ? { code } : {}) });

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function checkRequest(opId, body) {
  const op = contract.operations[opId];
  return op.request ? validate(body, op.request, comps) : [];
}

function toMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

function slotsFor(date, duration) {
  const day = new Date(`${date}T00:00:00`);
  if (day.getDay() === 0) return { hours: { closed: true }, slots: [] };
  const taken = bookings.filter((b) => b.date === date && b.status !== 'cancelled');
  const slots = [];
  for (let m = 9 * 60; m + duration <= 17 * 60; m += 30) {
    const clash = taken.some((b) => m < toMinutes(b.endTime) && toMinutes(b.time) < m + duration);
    if (!clash) slots.push({ time: hhmm(m), endTime: hhmm(m + duration), duration, available: true });
  }
  return { hours: { start: '09:00', end: '17:00' }, slots };
}

function payfastForm(kind, id, amount, buyer = {}) {
  return {
    success: true,
    kind,
    id,
    method: 'POST',
    action: `http://localhost:${PORT}/_payfast/process`,
    host: 'mock-payfast.local',
    fields: {
      merchant_id: '10000100',
      merchant_key: '46f0cd694581a',
      return_url: `${SITE_URL}/checkout/success`,
      cancel_url: `${SITE_URL}/checkout/cancel`,
      notify_url: `http://localhost:${PORT}${API}/payments/payfast/itn`,
      ...Object.fromEntries(Object.entries(buyer).filter(([, v]) => typeof v === 'string' && v)),
      m_payment_id: id,
      amount: amount.toFixed(2),
      item_name: `${site.companyName} ${kind} ${id.slice(-6)}`,
      custom_str2: kind,
      signature: 'mock-signature',
    },
  };
}

// ------------------------------------------------------------------ routes
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  // Simulated PayFast page.
  if (p === '/_payfast/process') {
    const form = await readBody(req);
    if (req.method === 'POST' && form && form.confirm === 'pay') {
      const o = orders.get(form.m_payment_id);
      if (o) o.paid = true;
      const b = bookings.find((x) => x._id === form.m_payment_id);
      if (b) b.status = 'confirmed';
      res.writeHead(303, { Location: form.return_url });
      return res.end();
    }
    const hidden = Object.entries(form || {})
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}">`)
      .join('');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Mock PayFast</title>
      <body style="font-family:sans-serif;max-width:420px;margin:60px auto;padding:0 16px">
      <h1>Mock PayFast</h1><p>Simulated payment of <b>R${form?.amount}</b> for ${form?.item_name}. No money moves.</p>
      <form method="post">${hidden}<button name="confirm" value="pay" style="padding:12px 20px">Pay (simulated)</button></form>
      <p><a href="${form?.cancel_url}">Cancel</a></p></body>`);
  }

  if (!p.startsWith(API)) return fail(res, 404, 'Not found');
  if (!String(req.headers.authorization || '').startsWith('Bearer ') || String(req.headers.authorization).length < 8) {
    return fail(res, 401, 'Website token missing');
  }
  const route = `${req.method} ${p.slice(API.length)}`;
  let m;

  if (route === 'GET /storefront/site') return send(res, 200, site, 'getSite');
  if (route === 'GET /storefront/categories') return send(res, 200, { categories }, 'listCategories');
  if (route === 'GET /storefront/products') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const c = url.searchParams.get('category');
    const featured = url.searchParams.get('featured') === 'true';
    const list = products.filter(
      (x) => (!q || x.name.toLowerCase().includes(q)) && (!c || x.category?.id === c) && (!featured || x.isFeatured),
    );
    return send(res, 200, { products: list }, 'listProducts');
  }
  if ((m = route.match(/^GET \/storefront\/products\/([^/]+)$/))) {
    const key = decodeURIComponent(m[1]);
    const prod = products.find((x) => x.id === key || x.slug === key);
    return prod ? send(res, 200, { product: prod }, 'getProduct') : fail(res, 404, 'Product not found');
  }
  if (route === 'POST /storefront/orders') {
    const body = await readBody(req);
    const errs = body ? checkRequest('createOrder', body) : ['invalid JSON'];
    if (errs.length) return fail(res, 400, errs.join('; '));
    const opt = site.deliveryOptions.find((o) => o.type === body.deliveryType);
    if (!opt) return fail(res, 400, 'Unknown deliveryType');
    const items = [];
    for (const it of body.items) {
      const prod = products.find((x) => x.id === it.productId);
      if (!prod) return fail(res, 400, 'One or more products are not available', 'PRODUCT_UNAVAILABLE');
      if (!prod.inStock) return fail(res, 409, `Only 0 of ${prod.name} left`, 'OUT_OF_STOCK');
      const v = it.variant && prod.variants.find((x) => x.name === it.variant.name)?.values.find((x) => x.value === it.variant.value);
      const unitPrice = v ? v.unitPrice : prod.unitPrice;
      items.push({ productId: prod.id, name: prod.name, image: prod.images[0] || null, variant: v ? v.value : '', quantity: it.quantity, unitPrice, lineTotal: Math.round(unitPrice * it.quantity * 100) / 100 });
    }
    const subtotal = Math.round(items.reduce((s, i) => s + i.lineTotal, 0) * 100) / 100;
    const order = {
      id: oid(),
      orderNumber: `KC-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
      status: 'pending',
      paid: false,
      items,
      subtotal,
      deliveryType: opt.type,
      deliveryPrice: opt.price,
      discountAmount: 0,
      total: subtotal + opt.price,
      currency: 'ZAR',
      createdAt: new Date().toISOString(),
    };
    orders.set(order.id, order);
    return send(res, 201, { order }, 'createOrder');
  }
  if ((m = route.match(/^GET \/storefront\/orders\/([^/]+)$/))) {
    const order = orders.get(m[1]);
    return order ? send(res, 200, { order }, 'getOrder') : fail(res, 404, 'Order not found');
  }
  if (route === 'POST /payments/payfast/checkout') {
    const body = await readBody(req);
    const order = body && orders.get(body.orderId);
    if (!order) return fail(res, 404, 'Order not found');
    if (order.paid) return fail(res, 409, 'Already paid', 'ALREADY_PAID');
    return send(res, 200, payfastForm('order', order.id, order.total, body.buyer), 'payfastOrderCheckout');
  }
  if (route === 'GET /storefront/bookings/services') return send(res, 200, { services }, 'listServices');
  if (route === 'GET /storefront/bookings/availability') {
    const date = url.searchParams.get('date');
    if (!date) return fail(res, 400, 'date is required');
    const duration = Number(url.searchParams.get('duration')) || 60;
    const { hours, slots } = slotsFor(date, duration);
    return send(res, 200, { date, duration, hours, availableSlots: slots }, 'getAvailability');
  }
  if (route === 'POST /storefront/bookings') {
    const body = await readBody(req);
    const errs = body ? checkRequest('createBooking', body) : ['invalid JSON'];
    if (errs.length) return fail(res, 400, errs.join('; '));
    const duration = body.duration || 60;
    if (!slotsFor(body.date, duration).slots.some((s) => s.time === body.time)) return fail(res, 409, 'That time was just taken');
    const deposit = Number(body.depositAmount) || 0;
    const booking = {
      _id: oid(),
      status: deposit > 0 ? 'pending' : 'confirmed',
      services: body.services,
      date: `${body.date}T00:00:00.000Z`,
      time: body.time,
      endTime: hhmm(toMinutes(body.time) + duration),
      duration,
      customerName: body.customerName,
      payment: { status: 'pending', ...(deposit ? { depositAmount: deposit } : {}), currency: 'ZAR' },
    };
    bookings.push({ ...booking, date: body.date });
    return send(res, 201, { booking, depositRequired: deposit > 0, message: deposit > 0 ? 'Booking created pending deposit payment' : 'Booking created' }, 'createBooking');
  }
  if (route === 'POST /payments/payfast/checkout/booking') {
    const body = await readBody(req);
    const b = body && bookings.find((x) => x._id === body.bookingId);
    if (!b) return fail(res, 404, 'Booking not found');
    return send(res, 200, payfastForm('booking', b._id, b.payment.depositAmount || 0), 'payfastBookingCheckout');
  }
  if (route === 'POST /email/contact') {
    const body = await readBody(req);
    const errs = body ? checkRequest('sendContact', body) : ['invalid JSON'];
    if (errs.length) return send(res, 400, { ok: false, message: errs.join('; ') });
    console.log(`✉ contact form from ${body.name} <${body.email}>`);
    return send(res, 200, { ok: true, message: 'Thank you for contacting us. We will get back to you soon.' }, 'sendContact');
  }
  return fail(res, 404, `Mock has no route for ${route}`);
});

server.listen(PORT, () => {
  console.log(`Mock storefront API on http://localhost:${PORT}${API} (site return URL ${SITE_URL})`);
});
