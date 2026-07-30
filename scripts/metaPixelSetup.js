/**
 * Inspect (and optionally create) a Conversions API pixel in a given Business Manager,
 * then point a client's tracking at it.
 *
 * Dry run (default, read-only):
 *   node scripts/metaPixelSetup.js --client Khana --business 1338736975980704
 *
 * Create a new pixel and repoint the client:
 *   node scripts/metaPixelSetup.js --client Khana --business 1338736975980704 \
 *     --create --name "KhanaConnect Tracking" --apply
 *
 * Repoint at an existing pixel:
 *   node scripts/metaPixelSetup.js --client Khana --pixel 1234567890 --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { decrypt } = require('../helpers/encryption');

const GRAPH = 'https://graph.facebook.com/v21.0';

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(`--${flag}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return !next || next.startsWith('--') ? true : next;
}
const has = (flag) => process.argv.includes(`--${flag}`);

async function graphGet(path, params) {
  const url = new URL(`${GRAPH}/${path}`);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  return { ok: res.ok, body: await res.json().catch(() => ({})) };
}

async function graphPost(path, params) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return { ok: res.ok, body: await res.json().catch(() => ({})) };
}

function maybeDecrypt(value) {
  if (!value || typeof value !== 'string' || !value.includes(':')) return value;
  try {
    return decrypt(value);
  } catch {
    return value;
  }
}

async function main() {
  let uri = process.env.CONNECTION_STRING || '';
  if (!/KhanaConnect_ProdDB/.test(uri)) {
    uri = uri.replace(
      '@khanaconnect.mvygpxm.mongodb.net/',
      '@khanaconnect.mvygpxm.mongodb.net/KhanaConnect_ProdDB'
    );
  }
  await mongoose.connect(uri);

  const Client = require('../models/client');
  const clientId = arg('client', 'Khana');
  const businessId = arg('business');
  const explicitPixel = arg('pixel');
  const apply = has('apply');

  const doc = await Client.findOne({ clientID: clientId });
  if (!doc) throw new Error(`Client ${clientId} not found`);
  const token = maybeDecrypt(doc.toObject().metaAds?.accessToken);
  if (!token) throw new Error(`Client ${clientId} has no Meta access token`);

  const currentPixel = maybeDecrypt(doc.toObject().metaAds?.pixelId);
  console.log(`Client ${clientId} currently sends to pixel: ${currentPixel || '(none)'}`);

  let targetPixel = explicitPixel && explicitPixel !== true ? String(explicitPixel) : null;

  if (businessId && !targetPixel) {
    const info = await graphGet(businessId, {
      fields: 'id,name,verification_status,created_time',
      access_token: token,
    });
    console.log(`\n=== Business ${businessId} ===`);
    console.log(
      info.ok
        ? `  ${info.body.name} | verification: ${info.body.verification_status || 'n/a'}`
        : `  error: ${JSON.stringify(info.body.error)}`
    );

    for (const edge of ['owned_pixels', 'client_pixels']) {
      const r = await graphGet(`${businessId}/${edge}`, {
        fields: 'id,name,last_fired_time',
        access_token: token,
      });
      console.log(`  ${edge}:`);
      if (r.ok && (r.body.data || []).length) {
        r.body.data.forEach((p) =>
          console.log(`    ${p.id}  ${p.name}  lastFired=${p.last_fired_time || 'never'}`)
        );
      } else {
        console.log(`    ${r.ok ? '(none)' : 'error: ' + JSON.stringify(r.body.error)}`);
      }
    }

    if (has('create')) {
      const name = arg('name', `${clientId} Conversions`);
      console.log(`\nCreating pixel "${name}" in business ${businessId} ...`);
      const created = await graphPost(`${businessId}/adspixels`, {
        name,
        access_token: token,
      });
      if (!created.ok) {
        console.log(`  FAILED: ${JSON.stringify(created.body.error)}`);
      } else {
        targetPixel = String(created.body.id);
        console.log(`  Created pixel ${targetPixel}`);
      }
    }
  }

  if (targetPixel) {
    const pix = await graphGet(targetPixel, {
      fields: 'name,owner_business{id,name},last_fired_time',
      access_token: token,
    });
    console.log(`\n=== Target pixel ${targetPixel} ===`);
    console.log(
      pix.ok
        ? `  ${pix.body.name} | owner: ${pix.body.owner_business?.name} (${pix.body.owner_business?.id})`
        : `  error: ${JSON.stringify(pix.body.error)}`
    );

    if (apply) {
      // Schema setter encrypts on assign — pass the raw id.
      doc.metaAds.pixelId = targetPixel;
      doc.metaAds.enabled = true;
      doc.markModified('metaAds');
      await doc.save();
      console.log(`\nAPPLIED: ${clientId} now sends events to pixel ${targetPixel}`);
    } else {
      console.log(`\nDry run — re-run with --apply to repoint ${clientId} at ${targetPixel}`);
    }
  }

  if (has('test')) {
    const pixel = targetPixel || currentPixel;
    if (!pixel) {
      console.log('\nNo pixel to test against.');
    } else {
      const testCode = arg('test-code');
      const payload = {
        data: [
          {
            event_name: 'Lead',
            event_time: Math.floor(Date.now() / 1000),
            event_id: `cli_test_${Date.now()}`,
            action_source: 'website',
            event_source_url: 'https://khanatechnologies.com/',
            user_data: {
              client_ip_address: '102.132.0.1',
              client_user_agent: 'KhanaConnect-Diagnostic/1.0',
            },
          },
        ],
        access_token: token,
      };
      if (testCode && testCode !== true) payload.test_event_code = String(testCode);

      const r = await graphPost(`${pixel}/events`, payload);
      console.log(`\n=== Test event -> pixel ${pixel} ===`);
      console.log(`  ${r.ok ? 'ACCEPTED' : 'REJECTED'}: ${JSON.stringify(r.body)}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Failed:', err.message);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
