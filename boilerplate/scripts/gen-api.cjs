#!/usr/bin/env node
/**
 * Regenerate the typed API client from the API's OpenAPI spec (../config/openapi.js).
 *
 *   node scripts/gen-api.cjs           write src/api/generated/{schema.ts,contract.snapshot.json}
 *   node scripts/gen-api.cjs --check   exit 1 if those files are out of date (CI / pre-commit)
 *
 * KHANA_API_REPO=<path> points at another checkout of the API (default: the parent folder).
 */
const fs = require('fs');
const path = require('path');
const { loadSpec, buildContract, generateTs, stableJson } = require('./openapi-contract.cjs');

const here = path.join(__dirname, '..');
const apiRoot = path.resolve(process.env.KHANA_API_REPO || path.join(here, '..'));
const outDir = path.join(here, 'src', 'api', 'generated');
const check = process.argv.includes('--check');

const { operations } = JSON.parse(fs.readFileSync(path.join(here, 'api.contract.json'), 'utf8'));
const { spec, apiPath } = loadSpec(apiRoot);

let contract;
try {
  contract = buildContract(spec, apiPath, operations);
} catch (err) {
  console.error(`\n✖ ${err.message}\n`);
  console.error('Either restore the endpoint in the API, or stop using it: remove it from api.contract.json and the code that calls it.');
  process.exit(1);
}

const files = {
  'schema.ts': generateTs(contract),
  'contract.snapshot.json': stableJson(contract),
};

let stale = 0;
for (const [name, content] of Object.entries(files)) {
  const file = path.join(outDir, name);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
  if (current === content) continue;
  stale += 1;
  if (check) console.error(`✖ src/api/generated/${name} is out of date`);
  else {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(file, content);
    console.log(`✔ wrote src/api/generated/${name}`);
  }
}
if (check && stale) {
  console.error('Run `npm run gen:api` in boilerplate/, then `npm run typecheck` and fix what breaks.');
  process.exit(1);
}
if (!stale) console.log(`✔ API client up to date (${Object.keys(contract.operations).length} operations)`);
