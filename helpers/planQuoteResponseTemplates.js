const { escapeHtml } = require('./transactionalEmailLayout');
const { formatDisplayDate } = require('./planQuoteEmail');

function formatZar(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return 'on enquiry';
  return `R${Number(amount).toLocaleString('en-ZA')}`;
}

function buildContext(quote, shareUrl, validUntil, senderName) {
  const firstName = String(quote.prospectName || '').trim().split(/\s+/)[0] || 'there';
  const est = quote.estimate || {};
  const sel = quote.selections || {};
  return {
    firstName,
    prospectName: quote.prospectName || '',
    businessName: quote.businessName || '',
    prospectEmail: quote.prospectEmail || '',
    shareUrl: shareUrl || '',
    validLabel: formatDisplayDate(validUntil),
    totalMonthly: formatZar(est.totalMonthly),
    totalSetup: formatZar(est.totalSetup),
    tierName: est.tierName || 'partnership plan',
    customBrief: String(sel.customBrief || '').trim(),
    needsCustom: !!sel.needsCustom,
    senderName: String(senderName || 'The Khana team').trim() || 'The Khana team',
  };
}

const PLAN_QUOTE_RESPONSE_TEMPLATES = [
  {
    id: 'mockup_offer',
    label: 'Offer a mockup',
    description: 'Ask if they want to move forward so you can draw up a mockup and confirm pricing.',
    subject: (ctx) => `Quick follow-up on your Khana estimate, ${ctx.firstName}`,
    buildParagraphs: (ctx) => [
      `Hi ${ctx.firstName},`,
      `I had a look at the estimate you put together${ctx.businessName ? ` for <strong>${escapeHtml(ctx.businessName)}</strong>` : ''} — thanks for taking the time to map that out.`,
      `If you&apos;re keen to move forward, we&apos;d be happy to put together a simple <strong>visual mockup</strong> of how your site or dashboard could look before anything is built. It&apos;s usually the easiest way to see the pieces coming together.`,
      `Before we do that, I just want to double-check that the <strong>pricing makes sense</strong> on your side: <strong>${escapeHtml(ctx.totalSetup)}</strong> once-off setup and <strong>${escapeHtml(ctx.totalMonthly)}/month</strong> on the ${escapeHtml(ctx.tierName)} plan (valid until ${escapeHtml(ctx.validLabel)}). If any line item felt unclear, reply here and we can walk through it.`,
      `Would you like us to go ahead with a mockup? A quick yes/no is fine — or we can jump on a short call if that&apos;s easier.`,
      `Warm regards,<br /><strong>${escapeHtml(ctx.senderName)}</strong><br />Khana Technologies`,
    ],
  },
  {
    id: 'pricing_clarity',
    label: 'Confirm pricing understanding',
    description: 'Friendly check that setup fee vs monthly partnership is clear.',
    subject: (ctx) => `Your Khana estimate — quick pricing check`,
    buildParagraphs: (ctx) => [
      `Hi ${ctx.firstName},`,
      `Hope you&apos;re having a good week. I&apos;m following up on the Khana plan estimate you requested.`,
      `I know the breakdown can be a lot at first glance, so I wanted to make sure the two main numbers are clear:`,
      `<ul style="margin:0 0 16px;padding-left:20px;line-height:1.7;color:#374151;">
        <li><strong>Once-off setup (${escapeHtml(ctx.totalSetup)})</strong> — covers building and launching your platform.</li>
        <li><strong>Monthly partnership (${escapeHtml(ctx.totalMonthly)}/mo)</strong> — hosting, support, and ongoing access to your dashboard and tools.</li>
      </ul>`,
      `Your full estimate is still here if you want to revisit the details: <a href="${escapeHtml(ctx.shareUrl)}" style="color:#2563eb;">view your estimate</a>.`,
      `Does that all line up with what you were expecting? Happy to adjust scope if something doesn&apos;t fit — just reply to this email.`,
      `Best,<br /><strong>${escapeHtml(ctx.senderName)}</strong><br />Khana Technologies`,
    ],
  },
  {
    id: 'interested_next_steps',
    label: 'Interested — next steps',
    description: 'Prospect seems keen; outline what happens if they want to proceed.',
    subject: (ctx) => `Next steps for your Khana platform, ${ctx.firstName}`,
    buildParagraphs: (ctx) => [
      `Hi ${ctx.firstName},`,
      `Great to see you&apos;re exploring Khana${ctx.businessName ? ` for <strong>${escapeHtml(ctx.businessName)}</strong>` : ''}. If you&apos;d like to move ahead, here&apos;s what usually happens next:`,
      `<ol style="margin:0 0 16px;padding-left:20px;line-height:1.7;color:#374151;">
        <li>We confirm your selections and answer any last questions (this email works perfectly).</li>
        <li>We agree on scope and send a short partnership agreement.</li>
        <li>Once setup is arranged, we schedule onboarding and start the build.</li>
      </ol>`,
      `Your estimate (${escapeHtml(ctx.totalSetup)} setup · ${escapeHtml(ctx.totalMonthly)}/mo) is valid until <strong>${escapeHtml(ctx.validLabel)}</strong>. You can review it anytime: <a href="${escapeHtml(ctx.shareUrl)}" style="color:#2563eb;">open your estimate</a>.`,
      `If you&apos;re ready, just reply with &quot;let&apos;s go&quot; or suggest a time for a quick call — whatever suits you.`,
      `Looking forward to hearing from you,<br /><strong>${escapeHtml(ctx.senderName)}</strong><br />Khana Technologies`,
    ],
  },
  {
    id: 'gentle_nudge',
    label: 'Gentle follow-up',
    description: 'Light check-in if they have not replied yet.',
    subject: (ctx) => `Still thinking about your Khana estimate?`,
    buildParagraphs: (ctx) => [
      `Hi ${ctx.firstName},`,
      `Just a quick note — I wanted to see if you had any questions about the Khana estimate you put together recently.`,
      `No pressure at all. Some people sit on it for a bit while they compare options, and that&apos;s completely fine. If something in the plan or pricing felt off, I&apos;d rather know so we can adjust before you decide.`,
      `Here&apos;s your link again when you need it: <a href="${escapeHtml(ctx.shareUrl)}" style="color:#2563eb;">view estimate</a> (valid until ${escapeHtml(ctx.validLabel)}).`,
      `Reply anytime — even a one-liner helps us know where you&apos;re at.`,
      `Thanks,<br /><strong>${escapeHtml(ctx.senderName)}</strong><br />Khana Technologies`,
    ],
  },
  {
    id: 'custom_scope_call',
    label: 'Custom system — scope call',
    description: 'For quotes with a custom brief; suggest a call to scope the build.',
    subject: (ctx) => `Your custom system idea — let's scope it properly`,
    buildParagraphs: (ctx) => [
      `Hi ${ctx.firstName},`,
      `Thanks for sharing what you&apos;re looking to build${ctx.businessName ? ` for <strong>${escapeHtml(ctx.businessName)}</strong>` : ''}. Custom work is where we like to be careful up front so everyone&apos;s aligned.`,
      ctx.customBrief
        ? `From your brief: <em>&quot;${escapeHtml(ctx.customBrief)}&quot;</em> — that gives us a good starting point.`
        : `We&apos;d love to hear a bit more detail on what you have in mind.`,
      `The estimate includes <strong>${escapeHtml(ctx.totalSetup)}</strong> setup and <strong>${escapeHtml(ctx.totalMonthly)}/month</strong> for the custom module on top of your plan. Before we lock anything in, we usually do a <strong>short scope call</strong> (15–20 minutes) to confirm what&apos;s realistic and what&apos;s included.`,
      `Would you be open to that this week? Reply with a few times that work for you, or tell us if you&apos;d prefer to refine the brief over email first.`,
      `Best,<br /><strong>${escapeHtml(ctx.senderName)}</strong><br />Khana Technologies`,
    ],
    isAvailable: (ctx) => ctx.needsCustom,
  },
  {
    id: 'book_discovery_call',
    label: 'Book a discovery call',
    description: 'Invite them to a short call to talk through the plan.',
    subject: (ctx) => `${ctx.firstName}, shall we hop on a quick call?`,
    buildParagraphs: (ctx) => [
      `Hi ${ctx.firstName},`,
      `Rather than going back and forth over email, I&apos;m happy to jump on a <strong>short discovery call</strong> (15–20 minutes) to talk through your Khana estimate and answer questions live.`,
      `We can cover what you selected, whether the ${escapeHtml(ctx.tierName)} plan is the right fit, and what timeline would work for you.`,
      `If that sounds useful, reply with a day or two that suit you and we&apos;ll send a calendar link. Your estimate stays here in the meantime: <a href="${escapeHtml(ctx.shareUrl)}" style="color:#2563eb;">view estimate</a>.`,
      `Speak soon,<br /><strong>${escapeHtml(ctx.senderName)}</strong><br />Khana Technologies`,
    ],
  },
];

function getTemplateById(templateId) {
  return PLAN_QUOTE_RESPONSE_TEMPLATES.find((t) => t.id === templateId) || null;
}

function listTemplatesForQuote(quote, shareUrl, validUntil, senderName) {
  const ctx = buildContext(quote, shareUrl, validUntil, senderName);
  return PLAN_QUOTE_RESPONSE_TEMPLATES.filter((t) => {
    if (typeof t.isAvailable === 'function') return t.isAvailable(ctx);
    return true;
  }).map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
    subjectPreview: t.subject(ctx),
  }));
}

function renderTemplateEmail(quote, templateId, shareUrl, validUntil, senderName) {
  const template = getTemplateById(templateId);
  if (!template) {
    throw new Error('Unknown response template');
  }
  const ctx = buildContext(quote, shareUrl, validUntil, senderName);
  if (typeof template.isAvailable === 'function' && !template.isAvailable(ctx)) {
    throw new Error('This template is not available for this quote');
  }
  const paragraphs = template.buildParagraphs(ctx);
  const bodyHtml = paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#374151;">${p}</p>`)
    .join('');

  return {
    subject: template.subject(ctx),
    bodyHtml,
    templateId: template.id,
    templateLabel: template.label,
  };
}

module.exports = {
  PLAN_QUOTE_RESPONSE_TEMPLATES,
  getTemplateById,
  listTemplatesForQuote,
  renderTemplateEmail,
  buildContext,
};
