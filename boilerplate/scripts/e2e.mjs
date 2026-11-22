#!/usr/bin/env node
/**
 * End-to-end API run of every flow the site uses, with each response checked against the
 * contract snapshot. Point it at the mock, a local API or staging (never production).
 *
 *   E2E_API=http://localhost:4010/api/v1 E2E_TOKEN=dev npm run e2e           (mock)
 *   E2E_API=http://localhost:3000/api/v1 E2E_TOKEN=<storefront token> npm run e2e
 *
 * Optional: E2E_CONTACT=1 also sends the contact form (it emails the business inbox).
 * PayFast: the run refuses to continue if the API returns a live (non-sandbox) PayFast form.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { validate } = require('./openapi-contract.cjs');
const contract = JSON.parse(readFileSync(path.join(here, '../src/api/generated/contract.snapshot.json'), 'utf8'));

const API = (process.env.E2E_API || 'http://localhost:4010/api/v1').replace(/\/+$/, '');
const TOKEN = process.env.E2E_TOKEN || 'dev-token';
if (/khanaconnect\.onrender\.com|api\.khana/i.test(API) && !process.env.E2E_I_KNOW_THIS_IS_NOT_PRODUCTION) {
  console.error(`Refusing to run against what looks like production (${API}).`);
  process.exit(2);
}

let failures = 0;
const ok = (msg) => console.log(`  ✔ ${msg}`);
const bad = (msg) => {
  failures += 1;
  console.error(`  ✖ ${msg}`);
};

async function call(opId, { path: params = {}, query = {}, body } = {}) {
  const op = contract.operations[opId];
  let url = op.path.replace(/\{(\w+)\}/g, (_, n) => encodeURIComponent(params[n]));
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined));
  if ([...qs].length) url += `?${qs}`;
  const res = await fetch(`${API}${url}`, {
    method: op.method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${opId} → HTTP ${res.status}: ${JSON.stringify(data)}`);
  const errs = validate(data, op.response, contract.schemas);
  if (errs.length) bad(`${opId} response does not match the contract:\n      ${errs.slice(0, 8).join('\n      ')}`);
  else ok(`${opId} (${op.method} ${op.path}) matches the contract`);
  return data;
}

function checkPayfast(checkout) {
  if (checkout.host.includes('mock-payfast')) return 'mock';
  if (!checkout.host.includes('sandbox')) {
    console.error(`✖ API returned a LIVE PayFast form (${checkout.host}). Set PAYFAST_SANDBOX=true on the API. Stopping.`);
    process.exit(1);
  }
  ok(`PayFast form targets the sandbox (${checkout.action}), signed: ${!!checkout.fields.signature}`);
  return 'sandbox';
}

async function mockPay(checkout) {
  const form = new URLSearchParams({ ...checkout.fields, confirm: 'pay' });
  const res = await fetch(checkout.action, { method: 'POST', body: form, redirect: 'manual' });
  if (res.status !== 303) throw new Error(`mock PayFast returned ${res.status}`);
  ok(`simulated PayFast payment → redirected to ${res.headers.get('location')}`);
}

async function storeFlow(site) {
  console.log('\nstore');
  await call('listCategories');
  const { products } = await call('listProducts');
  const product = products.find((p) => p.inStock && !p.variants.length) || products.find((p) => p.inStock);
  if (!product) return bad('no product in stock to order');
  await call('getProduct', { path: { idOrSlug: product.slug || product.id } });
  const variant = product.variants[0];
  const value = variant?.values.find((v) => v.inStock);
  const delivery = site.deliveryOptions[0]?.type || 'collection';
  const { order } = await call('createOrder', {
    body: {
      customer: { firstName: 'E2E', lastName: 'Shopper', email: 'e2e-shopper@example.com', phone: '0820000000' },
      shipping: { address: '1 Test Street', city: 'Pretoria', postalCode: '0181', country: 'ZA' },
      deliveryType: delivery,
      items: [{ productId: product.id, quantity: 2, ...(value ? { variant: { name: variant.name, value: value.value } } : {}) }],
    },
  });
  const unit = value ? value.unitPrice : product.unitPrice;
  if (Math.abs(order.subtotal - unit * 2) > 0.01) bad(`order subtotal ${order.subtotal} ≠ 2 × ${unit}`);
  else ok(`order ${order.orderNumber} priced by the API: ${order.total} ZAR, unpaid`);

  let checkout;
  try {
    checkout = await call('payfastOrderCheckout', {
      body: { orderId: order.id, buyer: { name_first: 'E2E', name_last: 'Shopper', email_address: 'e2e-shopper@example.com' } },
    });
  } catch (err) {
    if (String(err.message).includes('PAYFAST_NOT_CONFIGURED')) return bad('PayFast is not configured for this client (merchant_id / merchant_key / return_url)');
    throw err;
  }
  if (checkout.fields.amount !== order.total.toFixed(2)) bad(`PayFast amount ${checkout.fields.amount} ≠ order total ${order.total}`);
  else ok(`PayFast amount = order total (${checkout.fields.amount})`);
  if (checkPayfast(checkout) === 'mock') await mockPay(checkout);
  const after = await call('getOrder', { path: { id: order.id } });
  ok(`order status page: paid=${after.order.paid}${after.order.paid ? '' : ' (waits for the PayFast ITN)'}`);
}

async function bookingFlow() {
  console.log('\nbookings');
  const { services } = await call('listServices');
  if (!services.length) return bad('no bookable services');
  const service = services[0];
  let slot;
  let date;
  for (let i = 1; i <= 14 && !slot; i += 1) {
    const d = new Date(Date.now() + i * 864e5);
    date = d.toISOString().slice(0, 10);
    const avail = await call('getAvailability', { query: { date, serviceName: service.name, duration: service.duration } });
    slot = avail.availableSlots[0];
  }
  if (!slot) return bad('no free slot in the next 14 days');
  const created = await call('createBooking', {
    body: {
      customerName: 'E2E Booker',
      customerEmail: 'e2e-booker@example.com',
      customerPhone: '0820000001',
      services: [service.name],
      date,
      time: slot.time,
      duration: service.duration,
      depositAmount: 50,
    },
  });
  ok(`booking ${created.booking._id} ${created.booking.status} for ${date} ${slot.time}, deposit required: ${created.depositRequired}`);
  try {
    await call('createBooking', {
      body: { customerName: 'Clash', customerEmail: 'clash@example.com', customerPhone: '0820000002', services: [service.name], date, time: slot.time, duration: service.duration },
    });
    bad('double booking the same slot was accepted');
  } catch (err) {
    if (String(err.message).includes('HTTP 409')) ok('double booking the same slot is refused (409)');
    else throw err;
  }
  const checkout = await call('payfastBookingCheckout', { body: { bookingId: created.booking._id } });
  if (checkout.fields.amount !== '50.00') bad(`deposit amount ${checkout.fields.amount} ≠ 50.00`);
  if (checkPayfast(checkout) === 'mock') await mockPay(checkout);
}

async function contactFlow() {
  console.log('\ncontact');
  if (!process.env.E2E_CONTACT) return console.log('  – skipped (set E2E_CONTACT=1; it emails the business inbox)');
  await call('sendContact', { body: { name: 'E2E', email: 'e2e@example.com', message: 'End-to-end test message, please ignore.' } });
}

console.log(`e2e against ${API}`);
try {
  console.log('\nsite');
  const site = await call('getSite');
  const mode = process.env.E2E_MODE || 'both';
  if (mode !== 'bookings') await storeFlow(site);
  if (mode !== 'store') await bookingFlow();
  await contactFlow();
} catch (err) {
  bad(err.message);
}
console.log(failures ? `\n${failures} problem(s)` : '\nall flows passed');
process.exit(failures ? 1 : 0);
