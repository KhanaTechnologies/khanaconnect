const Client = require('../../models/client');
const NewsletterDraft = require('../../models/NewsletterDraft');
const NewsletterService = require('../../helpers/newsletterService');

/**
 * Agenda worker: send a saved newsletter campaign/draft to active subscribers.
 * Job data: { clientID, draftId }
 */
async function processNewsletterCampaign(data = {}) {
  const clientID = String(data.clientID || '').trim();
  const draftId = String(data.draftId || '').trim();
  if (!clientID || !draftId) {
    throw new Error('clientID and draftId are required');
  }

  const client = await Client.findOne({ clientID });
  if (!client) {
    throw new Error(`Client not found: ${clientID}`);
  }

  const draft = await NewsletterDraft.findOne({
    _id: draftId,
    clientID,
    isDeleted: false,
  });
  if (!draft) {
    throw new Error(`Newsletter campaign not found: ${draftId}`);
  }

  if (!draft.subject || !(draft.html || draft.text)) {
    draft.status = 'failed';
    draft.lastSendError = 'Campaign is missing subject or content';
    await draft.save();
    throw new Error(draft.lastSendError);
  }

  draft.status = 'sending';
  draft.lastSendError = '';
  await draft.save();

  const html = draft.html || String(draft.text || '').replace(/\n/g, '<br/>');
  const text =
    draft.text ||
    String(html)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);

  try {
    const result = await NewsletterService.sendNewsletter(
      client,
      {
        subject: draft.subject,
        html,
        text,
        enableTracking: true,
        newsletterId: `campaign_${draft._id}_${Date.now()}`,
      },
      { useSubscribers: true }
    );

    draft.status = 'sent';
    draft.sentAt = new Date();
    draft.scheduledFor = null;
    draft.agendaJobId = '';
    draft.recipientCount = result?.totalSent ?? result?.totalRecipients ?? draft.recipientCount;
    draft.lastSendError = '';
    await draft.save();
    return result;
  } catch (err) {
    draft.status = 'failed';
    draft.lastSendError = err.message || 'Send failed';
    draft.agendaJobId = '';
    await draft.save();
    throw err;
  }
}

module.exports = { processNewsletterCampaign };
