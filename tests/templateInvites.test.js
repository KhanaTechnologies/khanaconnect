/**
 * Offline tests for website-design gallery invites (model, mailer and admin auth are faked).
 * node tests/templateInvites.test.js
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');
const express = require('express');

process.env.MARKETING_SITE_URL = 'https://site.test/';

const ROOT = path.join(__dirname, '..');
const abs = (p) => path.join(ROOT, p);

// ---------------------------------------------------------------- fakes
const db = { invites: [] };
const sent = [];
let failEmail = false;
let nextId = 1;
const hex = (n) => n.toString(16).padStart(24, '0');

function makeDoc(fields) {
  const doc = { viewCount: 0, revokedAt: null, emailSentAt: null, firstViewedAt: null, lastViewedAt: null, ...fields };
  Object.defineProperty(doc, 'save', { value: async () => doc, enumerable: false });
  return doc;
}
function chain(rows) {
  const q = { sort: () => q, limit: (n) => { rows = rows.slice(0, n); return q; }, then: (a, b) => Promise.resolve(rows).then(a, b) };
  return q;
}
const fakeInviteModel = {
  async create(fields) {
    const doc = makeDoc({ _id: hex(nextId++), createdAt: new Date(), ...fields });
    db.invites.push(doc);
    return doc;
  },
  async findById(id) { return db.invites.find((i) => i._id === id) || null; },
  async findOne(f) { return db.invites.find((i) => i.token === f.token) || null; },
  find: () => chain([...db.invites].reverse()),
  async updateOne(f, u) {
    const row = db.invites.find((i) => i._id === f._id);
    if (u.$inc) for (const [k, v] of Object.entries(u.$inc)) row[k] = (row[k] || 0) + v;
    if (u.$set) Object.assign(row, u.$set);
    return { modifiedCount: 1 };
  },
};
const fakes = {
  [abs('models/TemplateGalleryInvite.js')]: fakeInviteModel,
  [abs('helpers/teamPasswordReset.js')]: {
    getKhanaAdminClient: async () => ({ clientID: 'admin', companyName: 'Khana', businessEmail: 'x', businessEmailPassword: 'y' }),
  },
  [abs('utils/email.js')]: {
    async sendTemplateGalleryInviteEmail(args) {
      if (failEmail) throw new Error('SMTP down');
      sent.push(args);
    },
  },
  [abs('middleware/requireAdmin.js')]: {
    requireAdmin(req, res, next) {
      if (req.headers.authorization !== 'Bearer admin') return res.status(403).json({ success: false, error: 'Admin access required' });
      req.user = { clientID: 'admin', email: 'boss@khana.test' };
      return next();
    },
  },
  [abs('helpers/failureEmail.js')]: {
    wrapRoute: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
  },
};
const origLoad = Module._load;
// Rate limiting is not under test (and some installs can't read it); pass straight through.
const bareFakes = { 'express-rate-limit': () => (_req, _res, next) => next() };
Module._load = function (request, parent, isMain) {
  if (bareFakes[request]) return bareFakes[request];
  if (parent && (request.startsWith('.') || path.isAbsolute(request))) {
    let resolved;
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch { resolved = null; }
    if (resolved && fakes[resolved]) return fakes[resolved];
  }
  return origLoad.apply(this, arguments);
};

const invites = require('../helpers/templateInvites');
const router = require('../routes/templateInvites');

// ---------------------------------------------------------------- tests
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('create needs a name or business, and a valid email when emailing', async () => {
  await assert.rejects(invites.createInvite({}), /name or business/);
  await assert.rejects(invites.createInvite({ name: 'Thandi', email: 'nope' }), /email address/);
  await assert.rejects(invites.createInvite({ name: 'Thandi', sendEmail: true }), /Add an email/);
});

test('create builds a gallery link, clamps days and emails when asked', async () => {
  const before = Date.now();
  const { invite, emailError } = await invites.createInvite(
    { name: ' Thandi ', businessName: 'Thandi Hair', email: 'T@Example.com', days: 500, sendEmail: true, note: 'IG lead' },
    { createdBy: 'boss' }
  );
  assert.strictEqual(emailError, '');
  assert.strictEqual(invite.name, 'Thandi');
  assert.strictEqual(invite.email, 't@example.com');
  assert.match(invite.token, /^[A-Za-z0-9_-]{32}$/);
  const days = (invite.expiresAt - before) / 86400000;
  assert.ok(days > 89.9 && days <= 90.01, `expected 90 days, got ${days}`);
  assert.ok(invite.emailSentAt);
  assert.strictEqual(sent.at(-1).to, 't@example.com');
  assert.strictEqual(sent.at(-1).galleryLink, `https://site.test/templates?invite=${invite.token}`);
  const out = invites.serializeInvite(invite);
  assert.strictEqual(out.status, 'active');
  assert.strictEqual(out.link, sent.at(-1).galleryLink);
});

test('a failed email keeps the invite and reports the error', async () => {
  failEmail = true;
  const { invite, emailError } = await invites.createInvite({ name: 'Sipho', email: 's@example.com', sendEmail: true });
  failEmail = false;
  assert.strictEqual(emailError, 'SMTP down');
  assert.strictEqual(invite.emailSentAt, null);
  assert.ok(db.invites.includes(invite));
});

test('checkInvite counts visits and refuses bad, expired and revoked links', async () => {
  const { invite } = await invites.createInvite({ name: 'Lebo', businessName: 'Lebo Bakes' });
  const first = await invites.checkInvite(invite.token);
  assert.deepStrictEqual({ ...first, expiresAt: undefined }, { valid: true, name: 'Lebo', businessName: 'Lebo Bakes', expiresAt: undefined });
  await invites.checkInvite(invite.token);
  assert.strictEqual(invite.viewCount, 2);
  await invites.checkInvite(invite.token, { countVisit: false });
  assert.strictEqual(invite.viewCount, 2, 'a re-check within the same visit is not counted');
  assert.ok(invite.firstViewedAt && invite.lastViewedAt);

  assert.deepStrictEqual(await invites.checkInvite('short'), { valid: false, reason: 'not_found' });
  assert.deepStrictEqual(await invites.checkInvite({ $ne: null }), { valid: false, reason: 'not_found' });
  assert.deepStrictEqual(await invites.checkInvite('x'.repeat(32)), { valid: false, reason: 'not_found' });

  invite.expiresAt = new Date(Date.now() - 1000);
  assert.deepStrictEqual(await invites.checkInvite(invite.token), { valid: false, reason: 'expired' });
  await invites.extendInvite(invite._id, { days: 7 });
  assert.strictEqual((await invites.checkInvite(invite.token)).valid, true);
  await invites.revokeInvite(invite._id);
  assert.deepStrictEqual(await invites.checkInvite(invite.token), { valid: false, reason: 'revoked' });
  await assert.rejects(invites.extendInvite(invite._id, {}), /revoked/);
  await assert.rejects(invites.resendInvite(invite._id, {}), /revoked/);
});

test('resend renews an expired invite and needs an email', async () => {
  const { invite } = await invites.createInvite({ name: 'Ayanda', email: 'a@example.com' });
  invite.expiresAt = new Date(Date.now() - 1000);
  await invites.resendInvite(invite._id, {});
  assert.strictEqual(invites.inviteStatus(invite), 'active');
  assert.strictEqual(sent.at(-1).to, 'a@example.com');

  const { invite: noEmail } = await invites.createInvite({ name: 'No Mail' });
  await assert.rejects(invites.resendInvite(noEmail._id, {}), /no email/);
  await assert.rejects(invites.resendInvite('not-an-id', {}), /not found/);
});

test('routes: admin-only management, public check returns 404 for dead links', async () => {
  const app = express();
  // Tiny JSON body reader (keeps the test independent of body-parser's lazy-loaded decoders).
  app.use((req, _res, next) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; } next(); });
  });
  app.use('/api/v1', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
  try {
    assert.strictEqual((await fetch(`${base}/admin/template-invites`)).status, 403);

    const created = await fetch(`${base}/admin/template-invites`, {
      method: 'POST', headers: admin, body: JSON.stringify({ businessName: 'Route Co', days: 14 }),
    });
    assert.strictEqual(created.status, 201);
    const { invite } = await created.json();
    assert.strictEqual(invite.status, 'active');
    const token = new URL(invite.link).searchParams.get('invite');

    const bad = await fetch(`${base}/admin/template-invites`, { method: 'POST', headers: admin, body: '{}' });
    assert.strictEqual(bad.status, 400);

    const list = await (await fetch(`${base}/admin/template-invites`, { headers: admin })).json();
    assert.ok(list.invites.some((i) => i.id === invite.id));
    assert.ok(!('token' in list.invites[0]), 'raw token field is not exposed separately');

    const ok = await fetch(`${base}/public/template-invites/${token}?visit=1`);
    assert.strictEqual(ok.status, 200);
    const okBody = await ok.json();
    assert.strictEqual(okBody.businessName, 'Route Co');
    assert.ok(!('note' in okBody) && !('email' in okBody), 'public check hides private fields');
    await fetch(`${base}/public/template-invites/${token}`);
    const counted = (await (await fetch(`${base}/admin/template-invites`, { headers: admin })).json()).invites.find((i) => i.id === invite.id);
    assert.strictEqual(counted.viewCount, 1, 'only ?visit=1 counts');

    const revoked = await fetch(`${base}/admin/template-invites/${invite.id}`, { method: 'DELETE', headers: admin });
    assert.strictEqual((await revoked.json()).invite.status, 'revoked');
    const dead = await fetch(`${base}/public/template-invites/${token}`);
    assert.strictEqual(dead.status, 404);
    assert.strictEqual((await dead.json()).reason, 'revoked');

    assert.strictEqual((await fetch(`${base}/admin/template-invites/zzz/extend`, { method: 'POST', headers: admin, body: '{}' })).status, 404);
  } finally {
    server.close();
  }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${name}\n     ${err.stack}`);
    }
  }
  console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
