/**
 * Offline tests: one email when someone starts a WhatsApp conversation, not one per message.
 * node tests/whatsappNewContactAlert.test.js
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const Module = require('module');

process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
delete process.env.WHATSAPP_NEW_CONTACT_ALERT_CLIENT_IDS;
delete process.env.WHATSAPP_NEW_CONTACT_ALERT_EMAILS;
delete process.env.WHATSAPP_NEW_CONTACT_ALERTS_DISABLED;
delete process.env.WHATSAPP_NEW_CONTACT_QUIET_HOURS;

const ROOT = path.join(__dirname, '..');
const abs = (p) => path.join(ROOT, p);

// ---------------------------------------------------------------- fakes
const db = { messages: [], clients: [], members: [] };
const sentEmails = [];

function chain(value) {
  const q = { select: () => q, sort: () => q, lean: async () => value, then: (a, b) => Promise.resolve(value).then(a, b) };
  return q;
}

const fakeMessage = {
  findOne(f) {
    const rows = db.messages
      .filter(
        (m) =>
          m.contact_wa_id === f.contact_wa_id &&
          m.direction === f.direction &&
          m.wamid !== f.wamid.$ne &&
          m.timestamp < f.timestamp.$lt
      )
      .sort((a, b) => b.timestamp - a.timestamp);
    return chain(rows[0] || null);
  },
};
const fakeClient = { findOne: (f) => chain(db.clients.find((c) => c.clientID === f.clientID) || null) };
const fakeTeamMember = {
  find: (f) => chain(db.members.filter((m) => m.clientID === f.clientID && m.status === 'active' && f.orgRole.$in.includes(m.orgRole))),
};
const fakeSender = {
  async sendWhatsAppNewContactAlertEmail(args) {
    sentEmails.push(args);
    return { sent: args.recipients.length };
  },
};
const fakeAuto = { isActiveForClient: async (id) => id === 'Khana' };

const stubs = {
  [abs('models/SaasWhatsAppMessage.js')]: fakeMessage,
  [abs('models/client.js')]: fakeClient,
  [abs('models/teamMember.js')]: fakeTeamMember,
  [abs('utils/sendWhatsAppNewContactAlert.js')]: fakeSender,
  [abs('services/saas/WhatsAppAutoResponderService.js')]: fakeAuto,
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

const { encrypt } = require(abs('helpers/encryption'));
const { maybeAlertNewContact } = require(abs('helpers/whatsappNewContactAlert'));

// ---------------------------------------------------------------- helpers
const HOUR = 60 * 60 * 1000;
const t0 = new Date('2026-11-21T08:00:00Z');
const at = (h) => new Date(t0.getTime() + h * HOUR);

function reset() {
  db.messages = [];
  sentEmails.length = 0;
  db.clients = [{ clientID: 'Khana', companyName: 'Khana Technologies', businessEmail: encrypt('contact@khanatechnologies.co.za') }];
  db.members = [{ clientID: 'Khana', status: 'active', orgRole: 'owner', email: 'Jason@Example.com' }];
}

async function inbound({ wamid, contact = '27820000001', h = 0, clientId = 'Khana', body = 'Hi' }) {
  const msg = { wamid, contact_wa_id: contact, direction: 'inbound', timestamp: at(h) };
  db.messages.push(msg); // the inbox saves the message before alerting
  return maybeAlertNewContact({ clientId, contactWaId: contact, contactName: 'Thandi', wamid, body, timestamp: at(h) });
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('first message from a new person sends one email to the business and the owner', async () => {
  reset();
  const r = await inbound({ wamid: 'w1' });
  assert.strictEqual(r.sent, 2);
  assert.strictEqual(sentEmails.length, 1);
  assert.deepStrictEqual(sentEmails[0].recipients, ['contact@khanatechnologies.co.za', 'jason@example.com']);
  assert.strictEqual(sentEmails[0].contact.firstEver, true);
  assert.strictEqual(sentEmails[0].autoReplyActive, true);
});

test('follow-up messages in the same conversation do not send more emails', async () => {
  reset();
  await inbound({ wamid: 'w1', h: 0 });
  const r2 = await inbound({ wamid: 'w2', h: 0.1 });
  const r3 = await inbound({ wamid: 'w3', h: 5 });
  assert.strictEqual(r2.reason, 'ongoing_conversation');
  assert.strictEqual(r3.reason, 'ongoing_conversation');
  assert.strictEqual(sentEmails.length, 1);
});

test('the same person coming back after 12+ quiet hours is a new conversation', async () => {
  reset();
  await inbound({ wamid: 'w1', h: 0 });
  await inbound({ wamid: 'w2', h: 13 });
  assert.strictEqual(sentEmails.length, 2);
  assert.strictEqual(sentEmails[1].contact.firstEver, false);
});

test('different people each get their own email', async () => {
  reset();
  await inbound({ wamid: 'a1', contact: '27820000001' });
  await inbound({ wamid: 'b1', contact: '27820000002' });
  assert.strictEqual(sentEmails.length, 2);
});

test('other businesses on the platform are not emailed by default', async () => {
  reset();
  db.clients.push({ clientID: 'Salon1', companyName: 'Salon', businessEmail: encrypt('s@example.com') });
  const r = await inbound({ wamid: 'x1', clientId: 'Salon1' });
  assert.strictEqual(r.reason, 'disabled');
  assert.strictEqual(sentEmails.length, 0);
});

test('WHATSAPP_NEW_CONTACT_ALERT_EMAILS overrides who gets the email', async () => {
  reset();
  process.env.WHATSAPP_NEW_CONTACT_ALERT_EMAILS = 'me@example.com, me@example.com';
  await inbound({ wamid: 'w1' });
  delete process.env.WHATSAPP_NEW_CONTACT_ALERT_EMAILS;
  assert.deepStrictEqual(sentEmails[0].recipients, ['me@example.com']);
});

test('the switch turns it off', async () => {
  reset();
  process.env.WHATSAPP_NEW_CONTACT_ALERTS_DISABLED = 'true';
  const r = await inbound({ wamid: 'w1' });
  delete process.env.WHATSAPP_NEW_CONTACT_ALERTS_DISABLED;
  assert.strictEqual(r.reason, 'disabled');
});

test('the email shows the name, number and message, escaped', () => {
  // Load the real email builder (not the stub) for this check.
  delete stubs[abs('utils/sendWhatsAppNewContactAlert.js')];
  stubs[abs('helpers/mailer.js')] = { sendMailWithRetry: async () => {} };
  const { buildNewContactEmail } = require(abs('utils/sendWhatsAppNewContactAlert'));
  const { subject, html } = buildNewContactEmail({
    client: { clientID: 'Khana', companyName: 'Khana Technologies' },
    contact: { contactWaId: '27820000001', contactName: 'Thandi', body: 'How much <b>is</b> it?', type: 'text', timestamp: t0, firstEver: true },
    autoReplyActive: false,
  });
  assert.strictEqual(subject, 'New WhatsApp enquiry from Thandi');
  assert.ok(html.includes('+27820000001'));
  assert.ok(html.includes('https://wa.me/27820000001'));
  assert.ok(html.includes('How much &lt;b&gt;is&lt;/b&gt; it?'));
  assert.ok(!html.includes('automatic reply'));
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
