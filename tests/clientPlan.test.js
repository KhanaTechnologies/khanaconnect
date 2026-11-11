/**
 * Offline tests: everything a client is allowed follows their plan (subscription.plan),
 * not the retired Bronze / Silver / Gold tier.
 * No database, no network:  node tests/clientPlan.test.js
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const Module = require('module');

process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const ROOT = path.join(__dirname, '..');
const abs = (p) => path.join(ROOT, p);

// ---------------------------------------------------------------- in-memory fakes
const db = { clients: [], members: [], pricingConfig: null, rules: [] };

function lean(value) {
  return { lean: async () => value, then: (ok, fail) => Promise.resolve(value).then(ok, fail) };
}
function query(value) {
  const q = lean(value);
  q.select = () => q;
  q.sort = () => q;
  return q;
}

const fakeClient = {
  findOne(filter) {
    return query(db.clients.find((c) => c.clientID === filter.clientID) || null);
  },
};
const fakeTeamMember = {
  async countDocuments(filter) {
    return db.members.filter((m) => m.clientID === filter.clientID && filter.status.$in.includes(m.status)).length;
  },
};
const fakePricingConfig = {
  findOne() {
    return query(db.pricingConfig);
  },
};
const fakeRule = {
  find(filter) {
    const keys = filter.$or[0].tier.$in;
    const rows = db.rules.filter(
      (r) =>
        r.service === filter.service &&
        r.message_type === filter.message_type &&
        r.active &&
        (keys.includes(r.tier) || r.tier === 'all' || r.tier == null)
    );
    return query(rows);
  },
};

const stubs = {
  [abs('models/client.js')]: fakeClient,
  [abs('models/teamMember.js')]: fakeTeamMember,
  [abs('models/PartnershipPricingConfig.js')]: fakePricingConfig,
  [abs('models/SaasPricingRule.js')]: fakeRule,
  [abs('models/SaasUsageEvent.js')]: { aggregate: async () => [] },
};
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let file;
  try {
    file = origResolve.call(this, request, parent, isMain);
  } catch {
    return origLoad.apply(this, arguments);
  }
  if (stubs[file]) return stubs[file];
  return origLoad.apply(this, arguments);
};

const plan = require(abs('helpers/clientPlan'));
const { getTeamSeatUsage, assertTeamSeatAvailable } = require(abs('helpers/teamSeats'));
const PricingService = require(abs('services/saas/PricingService'));
const { applySubscriptionUpdate, serializeSubscriptionSummary } = require(abs('helpers/clientSubscription'));

// ---------------------------------------------------------------- tests
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const client = (id, sub, extra = {}) => ({ clientID: id, role: 'client', subscription: sub, ...extra });
const members = (id, n) => Array.from({ length: n }, () => ({ clientID: id, status: 'active' }));

test('plan names parse strictly; old tier names map to plans', () => {
  assert.strictEqual(plan.parsePlanInput('Growth'), 'growth');
  assert.strictEqual(plan.parsePlanInput('bronze'), 'starter');
  assert.strictEqual(plan.parsePlanInput('silver'), 'launch');
  assert.strictEqual(plan.parsePlanInput('gold'), 'growth');
  assert.strictEqual(plan.parsePlanInput('platinum'), null);
  assert.strictEqual(plan.parsePlanInput(''), null);
});

test('a client with no plan is on Starter', () => {
  assert.strictEqual(plan.planIdForClient({}), 'starter');
  assert.strictEqual(plan.planIdForClient(null), 'starter');
});

test('included seats match the terms: Starter 1, Launch 1, Growth 3, Scale 5', () => {
  assert.deepStrictEqual(
    ['starter', 'launch', 'growth', 'scale'].map((p) => plan.includedSeatsForPlan(p)),
    [1, 1, 3, 5]
  );
});

test('seat limit = included seats + paid extra seats; admin is unlimited', () => {
  assert.strictEqual(plan.seatLimitForClient(client('a', { plan: 'growth', extraSeats: 2 })), 5);
  assert.strictEqual(plan.seatLimitForClient(client('a', { plan: 'scale' })), 5);
  assert.strictEqual(plan.seatLimitForClient({ role: 'admin' }), plan.UNLIMITED_SEATS);
});

test('a leftover tier field is ignored: Scale client with tier "bronze" still gets 5 seats', () => {
  assert.strictEqual(plan.seatLimitForClient(client('a', { plan: 'scale' }, { tier: 'bronze' })), 5);
});

test('Meta campaign caps follow the plan: Starter 5, Launch 25, Growth and up unlimited', () => {
  assert.deepStrictEqual(
    ['starter', 'launch', 'growth', 'scale', 'enterprise'].map((p) => plan.metaCampaignCapForPlan(p)),
    [5, 25, 0, 0, 0]
  );
});

test('getTeamSeatUsage reports the plan, not Bronze', async () => {
  db.clients = [client('g1', { plan: 'growth' })];
  db.members = members('g1', 2);
  db.pricingConfig = null;
  const u = await getTeamSeatUsage('g1');
  assert.strictEqual(u.plan, 'growth');
  assert.strictEqual(u.planLabel, 'Growth');
  assert.strictEqual(u.tierLabel, 'Growth');
  assert.strictEqual(u.limit, 3);
  assert.strictEqual(u.remaining, 1);
  assert.strictEqual(u.atLimit, false);
});

test('Starter owner alone is at the limit; adding a seat is refused with the plan name', async () => {
  db.clients = [client('s1', { plan: 'starter' })];
  db.members = members('s1', 1);
  await assert.rejects(assertTeamSeatAvailable('s1'), (err) => {
    assert.strictEqual(err.status, 403);
    assert.match(err.message, /Starter plan/);
    assert.doesNotMatch(err.message, /Bronze/);
    return true;
  });
});

test('included seats edited in Website Pricing are used', async () => {
  db.clients = [client('s2', { plan: 'starter' })];
  db.members = members('s2', 1);
  db.pricingConfig = { planBuilder: { includedSeats: { starter: 2 } } };
  const u = await getTeamSeatUsage('s2');
  assert.strictEqual(u.limit, 2);
  db.pricingConfig = null;
});

test('pricing rules: a plan rule wins, an old "gold" rule still applies to Growth, else "all"', async () => {
  db.rules = [
    { service: 'ads_service_fee', message_type: 'setup', active: true, tier: 'all', cost_per_unit: 10 },
    { service: 'ads_service_fee', message_type: 'setup', active: true, tier: 'scale', cost_per_unit: 4 },
    { service: 'ads_service_fee', message_type: 'setup', active: true, tier: 'gold', cost_per_unit: 6 },
  ];
  assert.strictEqual((await PricingService.getActiveRule('ads_service_fee', 'setup', 'scale')).cost_per_unit, 4);
  assert.strictEqual((await PricingService.getActiveRule('ads_service_fee', 'setup', 'growth')).cost_per_unit, 6);
  assert.strictEqual((await PricingService.getActiveRule('ads_service_fee', 'setup', 'starter')).cost_per_unit, 10);
});

test('admin subscription update sets plan and extra seats, and rejects unknown plans', () => {
  const c = { subscription: { plan: 'starter' } };
  applySubscriptionUpdate(c, { plan: 'Scale', extraSeats: 2 });
  assert.strictEqual(c.subscription.plan, 'scale');
  assert.strictEqual(c.subscription.extraSeats, 2);
  assert.throws(() => applySubscriptionUpdate(c, { plan: 'gold-plus' }), (e) => e.status === 400);
  assert.throws(() => applySubscriptionUpdate(c, { extraSeats: -1 }), (e) => e.status === 400);
  assert.strictEqual(c.subscription.plan, 'scale');
});

test('subscription summary shows the normalized plan', () => {
  const s = serializeSubscriptionSummary({ subscription: { plan: 'gold', paidUntil: new Date(Date.now() + 864e5) } });
  assert.strictEqual(s.plan, 'growth');
  assert.strictEqual(s.extraSeats, 0);
});

test('no Bronze/Silver/Gold left in client-facing code', () => {
  const fs = require('fs');
  for (const f of ['helpers/teamSeats.js', 'helpers/teamLogin.js', 'services/saas/AdsService.js', 'models/client.js', 'helpers/clientCreate.js']) {
    const src = fs.readFileSync(abs(f), 'utf8');
    assert.doesNotMatch(src, /bronze|silver|gold/i, f);
  }
});

(async () => {
  let passed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`ok   ${t.name}`);
    } catch (err) {
      process.exitCode = 1;
      console.log(`FAIL ${t.name}\n     ${err && err.message}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
