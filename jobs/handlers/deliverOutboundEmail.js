const Client = require('../../models/client');
const { deliverQueuedOutboundEmail } = require('../../utils/email');

async function deliverOutboundEmail({ clientID, mailOptions, label }) {
  if (!clientID || !mailOptions) {
    throw new Error('Invalid outbound email job payload');
  }

  const client = await Client.findOne({ clientID }).select('businessEmail businessEmailPassword');
  if (!client?.businessEmail) {
    throw new Error(`No client or business email for ${clientID}`);
  }

  await deliverQueuedOutboundEmail(client.businessEmail, client.businessEmailPassword, mailOptions);
  return { ok: true, clientID, label: label || '' };
}

module.exports = { deliverOutboundEmail };
