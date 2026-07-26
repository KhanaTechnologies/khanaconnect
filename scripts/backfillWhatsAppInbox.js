/**
 * One-time: seed SaasWhatsAppMessage outbound rows from SaasUsageEvent
 * so the dashboard inbox shows past template sends.
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  let connectUri = process.env.CONNECTION_STRING || '';
  if (!/KhanaConnect_ProdDB/.test(connectUri)) {
    connectUri = connectUri.replace(
      '@khanaconnect.mvygpxm.mongodb.net/',
      '@khanaconnect.mvygpxm.mongodb.net/KhanaConnect_ProdDB'
    );
  }
  await mongoose.connect(connectUri);
  const db = mongoose.connection.db;

  const usage = await db
    .collection('saasusageevents')
    .find({ service: 'whatsapp', source_ref: { $exists: true, $ne: '' } })
    .toArray();

  const account = await db.collection('saaswhatsappaccounts').findOne({
    client_id: 'Khana',
    status: 'active',
  });
  const phoneNumberId = account?.phone_number_id || '';

  let inserted = 0;
  let skipped = 0;
  for (const u of usage) {
    const wamid = String(u.source_ref || '').trim();
    const to = String(u.metadata?.to || '').replace(/\D/g, '');
    if (!wamid || !to) {
      skipped += 1;
      continue;
    }
    const templateName = String(u.metadata?.templateName || 'template');
    const res = await db.collection('saaswhatsappmessages').updateOne(
      { wamid },
      {
        $setOnInsert: {
          client_id: u.client_id || 'Khana',
          phone_number_id: phoneNumberId,
          contact_wa_id: to,
          contact_name: '',
          direction: 'outbound',
          wamid,
          type: 'template',
          body: `Template: ${templateName}`,
          template_name: templateName,
          status: u.status === 'processed' ? 'delivered' : 'sent',
          timestamp: u.created_at || new Date(),
          raw: null,
          read_at: null,
          error: '',
          created_at: new Date(),
          updated_at: new Date(),
        },
      },
      { upsert: true }
    );
    if (res.upsertedCount) inserted += 1;
    else skipped += 1;
  }

  const total = await db.collection('saaswhatsappmessages').countDocuments();
  console.log(JSON.stringify({ usage: usage.length, inserted, skipped, total }, null, 2));
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
