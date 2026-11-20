/**
 * Offline tests for owner alerts: Khana's number → the client's own number → email.
 * node tests/ownerAlerts.test.js
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const Module = require('module');

process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
delete process.env.OWNER_ALERTS_SENDER_CLIENT_ID;
delete process.env.WHATSAPP_NEW_CONTACT_ALERT_CLIENT_IDS;

const ROOT = path.join(__dirname, '..');
const abs = (p) => path.join(ROOT, p);

// ---------------------------------------------------------------- fakes
const db = { clients: [], accounts: [], templates: [], alerts: [], members: [], messages: [] };
const sent = { whatsapp: [], email: [] };
const failSenders = new Set();

function chain(value) {
  const q = { select: () => q, sort: () => q, lean: async () => value, then: (a, b) => Promise.resolve(value).then(a, b) };
  return q;
}
const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

const fakeClient = { findOne: (f) => chain(db.clients.find((c) => c.clientID === f.clientID) || null) };
const fakeAccount = {
  findOne: (f) => chain(db.accounts.find((a) => a.client_id === f.client_id && a.status === 'active') || null),
};
const fakeTeamMember = {
  find: (f) => chain(db.members.filter((m) => m.clientID === f.clientID && m.status === 'active')),
};
let nextId = 1;
const fakeAlert = {
  async create(doc) {
    if (db.alerts.some((a) => a.client_id === doc.client_id && a.key === doc.key)) {
      throw Object.assign(new Error('dup'), { code: 11000 });
    }
    const row = { _id: nextId++, wamid: '', channel: '', email_sent_at: null, ...doc };
    db.alerts.push(row);
    return row;
  },
  async updateOne(f, u) {
    const row = db.alerts.find((a) => a._id === f._id && (!('email_sent_at' in f) || a.email_sent_at === f.email_sent_at));
    if (!row) return { modifiedCount: 0 };
    Object.assign(row, u.$set);
    return { modifiedCount: 1 };
  },
  findOne: (f) => chain(db.alerts.find((a) => a.wamid === f.wamid) || null),
};
const fakeTemplate = {
  findOne: (f) => chain(db.templates.find((t) => t.client_id === f.client_id && t.name === f.name) || null),
};
const fakeWhatsAppService = {
  async sendTemplateMessage({ clientId, to, templateName, components }) {
    if (failSenders.has(clientId)) throw new Error(`send from ${clientId} failed`);
    const wamid = `wamid.${sent.whatsapp.length + 1}`;
    sent.whatsapp.push({ from: clientId, to, templateName, params: components[0].parameters.map((p) => p.text), wamid });
    return { messages: [{ id: wamid }] };
  },
};
const fakeMailer = { sendMailWithRetry: async (opts) => sent.email.push(opts) };
const fakeMailbox = {
  resolveMailbox: async () => ({ host: 'smtp', port: 465, secure: true, user: 'u', pass: 'p', fromEmail: 'contact@khanatechnologies.co.za' }),
};
const fakeAdmin = { getKhanaAdminClient: async () => ({ clientID: 'Khana' }) };
const fakeMessage = {
  findOne(f) {
    const rows = db.messages
      .filter((m) => m.contact_wa_id === f.contact_wa_id && m.wamid !== f.wamid.$ne && m.timestamp < f.timestamp.$lt)
      .sort((a, b) => b.timestamp - a.timestamp);
    return chain(rows[0] || null);
  },
};

const stubs = {
  [abs('models/client.js')]: fakeClient,
  [abs('models/SaasWhatsAppAccount.js')]: fakeAccount,
  [abs('models/teamMember.js')]: fakeTeamMember,
  [abs('models/WhatsAppOwnerAlert.js')]: fakeAlert,
  [abs('models/SaasWhatsAppTemplate.js')]: fakeTemplate,
  [abs('models/SaasWhatsAppMessage.js')]: fakeMessage,
  [abs('services/saas/WhatsAppService.js')]: fakeWhatsAppService,
  [abs('helpers/mailer.js')]: fakeMailer,
  [abs('utils/sendWhatsAppWindowCloseAlert.js')]: fakeMailbox,
  [abs('helpers/teamPasswordReset.js')]: fakeAdmin,
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
  return stubs[file] || origLoad.apply(this, arguments);
};

const OwnerAlertService = require(abs('services/saas/OwnerAlertService'));
const { maybeAlertOwnerOfNewChat } = require(abs('helpers/whatsappNewContactAlert'));

// ---------------------------------------------------------------- setup
const KHANA_NUMBER = '27766356790';
const SALON_NUMBER = '27120000000';
const OWNER_PHONE = '27821234567';

function reset({ whatsapp = {}, khanaTemplate = true, salonAccount = true, salonTemplate = true } = {}) {
  Object.assign(db, { clients: [], accounts: [], templates: [], alerts: [], members: [], messages: [] });
  sent.whatsapp = [];
  sent.email = [];
  failSenders.clear();
  db.clients.push({
    clientID: 'Salon1',
    companyName: 'Demo Salon',
    businessEmail: 'owner@salon.example',
    whatsapp: { ownerAlertsEnabled: true, ownerAlertPhone: OWNER_PHONE, ...whatsapp },
  });
  db.members.push({ clientID: 'Salon1', status: 'active', orgRole: 'owner', email: 'Naledi@Salon.example' });
  db.accounts.push({ client_id: 'Khana', status: 'active', display_phone_number: `+${KHANA_NUMBER}` });
  if (salonAccount) db.accounts.push({ client_id: 'Salon1', status: 'active', display_phone_number: `+${SALON_NUMBER}` });
  if (khanaTemplate) db.templates.push({ client_id: 'Khana', name: 'owner_new_activity' });
  if (salonTemplate) db.templates.push({ client_id: 'Salon1', name: 'owner_new_activity' });
}

const booking = { key: 'booking:1', event: 'booking', headline: 'New booking', details: 'Thandi M. · Fri 14:00' };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('sends from Khana’s number to the owner’s own phone', async () => {
  reset();
  const r = await OwnerAlertService.send('Salon1', booking);
  assert.strictEqual(r.channel, 'whatsapp');
  assert.strictEqual(sent.whatsapp.length, 1);
  assert.deepStrictEqual([sent.whatsapp[0].from, sent.whatsapp[0].to], ['Khana', OWNER_PHONE]);
  assert.deepStrictEqual(sent.whatsapp[0].params, ['New booking', 'Demo Salon', 'Thandi M. · Fri 14:00']);
  assert.strictEqual(sent.email.length, 0);
});

test('"business" target sends to the WhatsApp business number, from Khana (not from itself)', async () => {
  reset({ whatsapp: { ownerAlertTarget: 'business' } });
  await OwnerAlertService.send('Salon1', booking);
  assert.deepStrictEqual([sent.whatsapp[0].from, sent.whatsapp[0].to], ['Khana', SALON_NUMBER]);
});

test('if Khana can’t send, the client’s own number sends to the owner’s phone', async () => {
  reset({ khanaTemplate: false });
  const r = await OwnerAlertService.send('Salon1', booking);
  assert.strictEqual(r.sender, 'Salon1');
  assert.strictEqual(sent.whatsapp[0].to, OWNER_PHONE);
});

test('the business number is never messaged from itself; falls back to email instead', async () => {
  reset({ whatsapp: { ownerAlertTarget: 'business' }, khanaTemplate: false });
  const r = await OwnerAlertService.send('Salon1', booking);
  assert.strictEqual(sent.whatsapp.length, 0);
  assert.strictEqual(r.channel, 'email');
});

test('WhatsApp send errors fall through to email (business email + owner)', async () => {
  reset();
  failSenders.add('Khana');
  failSenders.add('Salon1');
  const r = await OwnerAlertService.send('Salon1', booking);
  assert.strictEqual(r.channel, 'email');
  assert.deepStrictEqual(sent.email.map((e) => e.to), ['owner@salon.example', 'naledi@salon.example']);
  assert.match(sent.email[0].subject, /New booking – Demo Salon/);
  assert.match(sent.email[0].html, /Thandi M\./);
});

test('no alert number set → email', async () => {
  reset({ whatsapp: { ownerAlertPhone: '' } });
  const r = await OwnerAlertService.send('Salon1', booking);
  assert.strictEqual(r.channel, 'email');
  assert.strictEqual(sent.whatsapp.length, 0);
});

test('email fallback can be switched off', async () => {
  reset({ whatsapp: { ownerAlertPhone: '', ownerAlertEmailFallback: false } });
  const r = await OwnerAlertService.send('Salon1', booking);
  assert.strictEqual(r.channel, 'none');
  assert.strictEqual(sent.email.length, 0);
});

test('alerts off, or that update switched off → nothing sent', async () => {
  reset({ whatsapp: { ownerAlertsEnabled: false } });
  assert.strictEqual((await OwnerAlertService.send('Salon1', booking)).skipped, 'off');
  reset({ whatsapp: { ownerAlertEvents: { booking: false } } });
  assert.strictEqual((await OwnerAlertService.send('Salon1', booking)).skipped, 'event_off');
  assert.strictEqual(sent.whatsapp.length + sent.email.length, 0);
});

test('the same booking alerts once', async () => {
  reset();
  await OwnerAlertService.send('Salon1', booking);
  const again = await OwnerAlertService.send('Salon1', booking);
  assert.strictEqual(again.skipped, 'duplicate');
  assert.strictEqual(sent.whatsapp.length, 1);
});

test('Meta says the WhatsApp alert wasn’t delivered → emailed once', async () => {
  reset();
  const r = await OwnerAlertService.send('Salon1', booking);
  assert.strictEqual(await OwnerAlertService.onUndelivered(r.wamid, 'not on WhatsApp'), true);
  await OwnerAlertService.onUndelivered(r.wamid, 'not on WhatsApp');
  assert.strictEqual(sent.email.length, 2); // two recipients, one email each, sent once
  assert.strictEqual(await OwnerAlertService.onUndelivered('wamid.other'), false);
});

test('new WhatsApp chat alerts the owner, once per conversation', async () => {
  reset();
  const at = new Date('2026-11-21T08:00:00Z');
  db.messages.push({ contact_wa_id: '27830000001', wamid: 'in1', timestamp: at });
  const r = await maybeAlertOwnerOfNewChat({ clientId: 'Salon1', contactWaId: '27830000001', contactName: 'Thandi', wamid: 'in1', body: 'Hi, are you open Saturday?', timestamp: at });
  assert.strictEqual(r.channel, 'whatsapp');
  assert.strictEqual(sent.whatsapp[0].params[0], 'New WhatsApp message');
  assert.match(sent.whatsapp[0].params[2], /Thandi \(\+27830000001\): "Hi, are you open Saturday\?"/);

  const later = new Date(at.getTime() + 60 * 1000);
  db.messages.push({ contact_wa_id: '27830000001', wamid: 'in2', timestamp: later });
  const r2 = await maybeAlertOwnerOfNewChat({ clientId: 'Salon1', contactWaId: '27830000001', wamid: 'in2', body: 'Hello?', timestamp: later });
  assert.strictEqual(r2.skipped, 'ongoing_conversation');
  assert.strictEqual(sent.whatsapp.length, 1);
});

test('no alert loops: messages from Khana’s number or the owner’s own phone are ignored', async () => {
  reset();
  const fromKhana = await maybeAlertOwnerOfNewChat({ clientId: 'Salon1', contactWaId: KHANA_NUMBER, wamid: 'k1', body: 'Heads up' });
  const fromOwner = await maybeAlertOwnerOfNewChat({ clientId: 'Salon1', contactWaId: OWNER_PHONE, wamid: 'o1', body: 'test' });
  assert.strictEqual(fromKhana.skipped, 'alert_sender');
  assert.strictEqual(fromOwner.skipped, 'own_number');
  assert.strictEqual(sent.whatsapp.length, 0);
});

test('Khana’s own lead inbox is left to the enquiry email, not owner alerts', async () => {
  reset();
  const r = await maybeAlertOwnerOfNewChat({ clientId: 'Khana', contactWaId: '27830000009', wamid: 'z1', body: 'Hi' });
  assert.strictEqual(r.skipped, 'khana_email');
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
      console.log(`FAIL ${t.name}\n     ${err && err.stack}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
