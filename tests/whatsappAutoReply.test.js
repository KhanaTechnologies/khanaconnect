/**
 * Offline tests for Khana's WhatsApp lead auto-replies: they match the right question
 * and stay short (one reply, one question, no forms).
 * node tests/whatsappAutoReply.test.js
 */

const assert = require('assert');
const path = require('path');

const { DEFAULT_RULES, matchAutoReplyRule } = require(path.join(__dirname, '..', 'helpers', 'whatsappAutoResponderRules'));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const cases = [
  ['Hi', 'greeting'],
  ['Good morning', 'greeting'],
  ['How much does it cost?', 'pricing'],
  ['Can I get more info please', 'more_info'],
  ['Do you have a free trial?', 'trial_demo'],
  ['How does whatsapp work with this', 'whatsapp_integration'],
  ['I need a website for my salon', 'website'],
  ['Do you do online orders', 'orders_ecommerce'],
  ['I only want to pay if it works', 'pay_when_works'],
  ['I have a business and need help', 'help_business'],
];

for (const [msg, id] of cases) {
  test(`"${msg}" → ${id}`, () => {
    const m = matchAutoReplyRule(msg);
    assert.ok(m, 'no match');
    assert.strictEqual(m.id, id);
  });
}

test('a long message that says hi is not answered with the greeting', () => {
  const m = matchAutoReplyRule('hi there, I run a bakery in Pretoria and wanted to ask a few things about it');
  assert.ok(!m || m.id !== 'greeting');
});

test('"this" does not count as "hi"', () => {
  assert.strictEqual(matchAutoReplyRule('this'), null);
});

test('every reply is short: under 400 characters', () => {
  for (const r of DEFAULT_RULES) {
    assert.ok(r.reply.length < 400, `${r.id} is ${r.reply.length} characters`);
  }
});

test('every reply asks at most one question and has no numbered form', () => {
  for (const r of DEFAULT_RULES) {
    const questions = (r.reply.match(/\?/g) || []).length;
    assert.ok(questions <= 1, `${r.id} asks ${questions} questions`);
    assert.doesNotMatch(r.reply, /^\s*\d\)/m, `${r.id} has a numbered form`);
  }
});

test('no jargon in replies', () => {
  for (const r of DEFAULT_RULES) {
    assert.doesNotMatch(r.reply, /Cloud API|credits|unused expire|partnership|operating system/i, r.id);
  }
});

let passed = 0;
for (const t of tests) {
  try {
    t.fn();
    passed += 1;
    console.log(`ok   ${t.name}`);
  } catch (err) {
    process.exitCode = 1;
    console.log(`FAIL ${t.name}\n     ${err && err.message}`);
  }
}
console.log(`\n${passed}/${tests.length} passed`);
