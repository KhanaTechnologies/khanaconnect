/**
 * Fails when an API change breaks the client-site boilerplate (boilerplate/).
 * No database, no network, no test runner:  node tests/boilerplateApiContract.test.js
 *                                       or:  npm run test:contract
 *
 * Checks, for every operation listed in boilerplate/api.contract.json:
 *  1. it is still documented in config/openapi.js;
 *  2. a route for it is still mounted in app.js (static read of app.js + routes/*.js);
 *  3. its request/response schemas match the snapshot the boilerplate was generated from
 *     (boilerplate/src/api/generated/contract.snapshot.json), and schema.ts is current.
 *
 * Fix for 3 after an intentional API change:  npm run boilerplate:api   then
 * cd boilerplate && npm run typecheck   and fix whatever the new types break.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BP = path.join(ROOT, 'boilerplate');
const lib = require(path.join(BP, 'scripts', 'openapi-contract.cjs'));

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  ✖ ${name}\n    ${String(err.message).replace(/\n/g, '\n    ')}`);
  }
}

const { operations } = JSON.parse(fs.readFileSync(path.join(BP, 'api.contract.json'), 'utf8'));
const { spec, apiPath } = lib.loadSpec(ROOT);
const readGenerated = (name) =>
  fs.readFileSync(path.join(BP, 'src', 'api', 'generated', name), 'utf8').replace(/\r\n/g, '\n');

console.log('boilerplate ↔ API contract');

let contract = null;
check('every operation the boilerplate uses is in config/openapi.js', () => {
  contract = lib.buildContract(spec, apiPath, operations);
});

check('every operation the boilerplate uses is mounted in app.js', () => {
  const table = new Set([...lib.routeTable(ROOT)].map((k) => lib.routeKey(k.split(' ')[0], k.split(' ')[1])));
  const missing = operations
    .filter((op) => !table.has(lib.routeKey(op.method, op.path)))
    .map((op) => `${op.method} ${op.path} ("${op.id}")`);
  assert.deepStrictEqual(missing, [], `No Express route found for:\n  - ${missing.join('\n  - ')}`);
});

check('request/response shapes match what the boilerplate was generated from', () => {
  assert(contract, 'skipped: operations missing');
  const snapshot = JSON.parse(readGenerated('contract.snapshot.json'));
  const changed = [];
  for (const [id, op] of Object.entries(contract.operations)) {
    if (JSON.stringify(op) !== JSON.stringify(snapshot.operations[id])) changed.push(`operation ${id} (${op.method} ${op.path})`);
  }
  const names = new Set([...Object.keys(contract.schemas), ...Object.keys(snapshot.schemas || {})]);
  for (const name of names) {
    if (JSON.stringify(contract.schemas[name]) !== JSON.stringify((snapshot.schemas || {})[name])) changed.push(`schema ${name}`);
  }
  assert.deepStrictEqual(
    changed,
    [],
    `The API changed under the boilerplate:\n  - ${changed.join('\n  - ')}\n` +
      'Run `npm run boilerplate:api`, then `cd boilerplate && npm run typecheck` and fix what breaks.'
  );
});

check('boilerplate/src/api/generated/schema.ts is current', () => {
  assert(contract, 'skipped: operations missing');
  assert.strictEqual(readGenerated('schema.ts'), lib.generateTs(contract), 'Run `npm run boilerplate:api`.');
});

// The checker itself must catch drift, or the checks above prove nothing.
check('detects a removed endpoint and a changed field (self-test)', () => {
  const clone = JSON.parse(JSON.stringify(spec));
  delete clone.paths[`${apiPath}/storefront/site`];
  assert.throws(() => lib.buildContract(clone, apiPath, operations), /GET \/storefront\/site/);

  const clone2 = JSON.parse(JSON.stringify(spec));
  clone2.components.schemas.StorefrontProduct.properties.unitPrice = { type: 'string' };
  const changed = lib.buildContract(clone2, apiPath, operations);
  assert.notStrictEqual(
    JSON.stringify(changed.schemas.StorefrontProduct),
    JSON.stringify(contract.schemas.StorefrontProduct)
  );
  // Doc-only edits must not trip the check.
  const clone3 = JSON.parse(JSON.stringify(spec));
  clone3.components.schemas.StorefrontProduct.properties.unitPrice.description = 'reworded';
  assert.deepStrictEqual(lib.buildContract(clone3, apiPath, operations), contract);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
