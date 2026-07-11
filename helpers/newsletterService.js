// helpers/newsletterService.js — client SMTP, HTML, attachments, signatures, tracking, unsubscribe
const crypto = require('crypto');
const { sendMailWithRetry } = require('./mailer');
const Email = require('../models/Email');
const EmailSubscriber = require('../models/emailSubscriber');
const NewsletterOpen = require('../models/NewsletterOpen');
const { mergeEmailSignature, escapeHtml } = require('./signatureHtml');
const {
  buildNewsletterKhanaAttributionHtml,
  buildUnsubscribeFooterRowHtml,
} = require('./emailDesignTokens');
const { resolvePublicBaseUrl, resolveApiBasePath } = require('./publicBaseUrl');
const { resolveSmtpHost, resolveSmtpPort, resolveSmtpSecure } = require('./mailHost');

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const RATE_LIMITS = {
  BATCH_SIZE: Math.min(500, Math.max(1, envInt('NEWSLETTER_BATCH_SIZE', 50))),
  BATCH_DELAY: envInt('NEWSLETTER_BATCH_DELAY_MS', 1000),
  EMAIL_DELAY: envInt('NEWSLETTER_EMAIL_DELAY_MS', 100),
  HOURLY_LIMIT: 500,
  DAILY_LIMIT: 2000,
};

const rateLimitStore = new Map();

function publicBaseUrl() {
  return resolvePublicBaseUrl();
}

function apiBasePath() {
  return resolveApiBasePath();
}

function hmacHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function newsletterSecret() {
  return process.env.secret || process.env.NEWSLETTER_HMAC_SECRET || 'change-me';
}

class NewsletterService {
  static signOpenToken(clientId, newsletterId, email) {
    const norm = String(email).toLowerCase().trim();
    return hmacHex(newsletterSecret(), `open|${clientId}|${newsletterId}|${norm}`);
  }

  static verifyOpenToken(clientId, newsletterId, email, sig) {
    if (!sig || !clientId || !newsletterId || !email) return false;
    const expected = this.signOpenToken(clientId, newsletterId, email);
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)));
    } catch {
      return false;
    }
  }

  static signUnsubscribeToken(clientId, email) {
    const norm = String(email).toLowerCase().trim();
    return hmacHex(newsletterSecret(), `unsub|${clientId}|${norm}`);
  }

  static verifyUnsubscribeToken(clientId, email, sig) {
    if (!sig || !clientId || !email) return false;
    const expected = this.signUnsubscribeToken(clientId, email);
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)));
    } catch {
      return false;
    }
  }

  static buildUnsubscribeUrl(email, clientId) {
    const base = publicBaseUrl();
    const api = apiBasePath();
    const sig = this.signUnsubscribeToken(clientId, email);
    const q = new URLSearchParams({
      email: String(email).toLowerCase().trim(),
      clientID: clientId,
      sig,
    });
    return `${base}${api}/email/newsletter/unsubscribe?${q.toString()}`;
  }

  static hasUnsubscribeMarkup(content) {
    const value = String(content || '');
    return (
      /\{\{\s*unsubscribe_(url|link)\s*\}\}/i.test(value) ||
      /\/email\/newsletter\/unsubscribe/i.test(value) ||
      /data-khana-unsubscribe/i.test(value) ||
      /data-khana-attribution/i.test(value) ||
      /data-khana-brand-header/i.test(value)
    );
  }

  static buildUnsubscribeFooterHtml(link) {
    return `${buildNewsletterKhanaAttributionHtml()}${buildUnsubscribeFooterRowHtml(link)}`;
  }

  static appendUnsubscribeFooterHtml(html, link) {
    const footer = this.buildUnsubscribeFooterHtml(link);
    const innerTableClose = /<\/table>\s*<\/td>\s*<\/tr>\s*<\/table>\s*<\/body>/i;
    if (innerTableClose.test(html)) {
      return html.replace(innerTableClose, `${footer}</table></td></tr></table></body>`);
    }
    if (/<\/body>/i.test(html)) {
      return html.replace(/<\/body>/i, `${footer}</body>`);
    }
    return `${html || ''}${footer}`;
  }

  static replaceUnsubscribePlaceholders(content, link) {
    return String(content || '')
      .replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, link)
      .replace(/\{\{\s*unsubscribe_link\s*\}\}/gi, link);
  }

  static applyPreviewUnsubscribe(html, clientId) {
    const link = this.buildUnsubscribeUrl('preview@example.com', clientId);
    let outHtml = this.replaceUnsubscribePlaceholders(html, link);
    if (!this.hasUnsubscribeMarkup(outHtml)) {
      outHtml = this.appendUnsubscribeFooterHtml(outHtml, link);
    }
    return outHtml;
  }

  static buildOpenPixelUrl(clientId, newsletterId, email) {
    const base = publicBaseUrl();
    const api = apiBasePath();
    const sig = this.signOpenToken(clientId, newsletterId, email);
    const q = new URLSearchParams({
      c: clientId,
      n: newsletterId,
      e: String(email).toLowerCase().trim(),
      s: sig,
    });
    return `${base}${api}/email/newsletter/open.gif?${q.toString()}`;
  }

  static appendTrackingPixel(html, clientId, newsletterId, recipientEmail, enabled) {
    if (!enabled || !html) return html;
    const url = this.buildOpenPixelUrl(clientId, newsletterId, recipientEmail);
    const pixel = `<img src="${url}" alt="" width="1" height="1" style="display:block;border:0;outline:none;" />`;
    if (/<\/body>/i.test(html)) {
      return html.replace(/<\/body>/i, `${pixel}</body>`);
    }
    return `${html}${pixel}`;
  }

  static addUnsubscribeFooter(html, text, email, clientId) {
    const link = this.buildUnsubscribeUrl(email, clientId);
    let outHtml = this.replaceUnsubscribePlaceholders(html, link);
    let outText = this.replaceUnsubscribePlaceholders(text, link);

    if (this.hasUnsubscribeMarkup(outHtml)) {
      if (!outText.includes(link)) {
        outText += `\n\nUnsubscribe: ${link}\n`;
      }
      return { html: outHtml, text: outText };
    }

    outHtml = this.appendUnsubscribeFooterHtml(outHtml, link);
    outText += `\n\n---\nUnsubscribe: ${link}\n`;

    return { html: outHtml, text: outText };
  }

  static checkRateLimit(clientId) {
    const now = Date.now();
    const hourAgo = now - 60 * 60 * 1000;
    const dayAgo = now - 24 * 60 * 60 * 1000;

    if (!rateLimitStore.has(clientId)) {
      rateLimitStore.set(clientId, []);
    }

    const clientEmails = rateLimitStore.get(clientId);
    const recentEmails = clientEmails.filter((timestamp) => timestamp > dayAgo);
    rateLimitStore.set(clientId, recentEmails);

    const hourlyCount = recentEmails.filter((timestamp) => timestamp > hourAgo).length;
    const dailyCount = recentEmails.length;

    return {
      hourly: hourlyCount,
      daily: dailyCount,
      canSend: hourlyCount < RATE_LIMITS.HOURLY_LIMIT && dailyCount < RATE_LIMITS.DAILY_LIMIT,
      remaining: {
        hourly: RATE_LIMITS.HOURLY_LIMIT - hourlyCount,
        daily: RATE_LIMITS.DAILY_LIMIT - dailyCount,
      },
    };
  }

  static updateRateLimit(clientId, count) {
    const now = Date.now();
    const timestamps = rateLimitStore.get(clientId) || [];
    for (let i = 0; i < count; i++) timestamps.push(now);
    rateLimitStore.set(clientId, timestamps);
  }

  static async getSubscribers(clientId, options = {}) {
    const { limit = 0, skip = 0, activeOnly = true } = options;

    const query = { clientID: clientId };
    if (activeOnly) query.isActive = true;

    const subscribers = await EmailSubscriber.find(query)
      .select('email name dateSubscribed isActive')
      .skip(skip)
      .limit(limit)
      .sort({ dateSubscribed: -1 })
      .lean();

    return subscribers.map((sub) => ({
      id: sub._id?.toString() || sub.email,
      email: sub.email,
      address: sub.email,
      name: sub.name,
      dateSubscribed: sub.dateSubscribed,
      subscribedAt: sub.dateSubscribed,
      isActive: sub.isActive !== false,
      subscribed: sub.isActive !== false,
    }));
  }

  static async getSubscriberCount(clientId, activeOnly = true) {
    const query = { clientID: clientId };
    if (activeOnly) query.isActive = true;
    return EmailSubscriber.countDocuments(query);
  }

  static async reactivateInactiveSubscribers(clientId) {
    const result = await EmailSubscriber.updateMany(
      { clientID: clientId, isActive: false },
      { $set: { isActive: true } }
    );
    return result.modifiedCount;
  }

  static async addSubscribers(clientId, subscribers) {
    const operations = [];
    const errors = [];

    for (const sub of subscribers) {
      const email = String(sub.email || '').toLowerCase().trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push(`Invalid email: ${sub.email || '(empty)'}`);
        continue;
      }

      let dateSubscribed = new Date();
      if (sub.dateSubscribed) {
        const parsed = new Date(sub.dateSubscribed);
        if (!Number.isNaN(parsed.getTime())) {
          dateSubscribed = parsed;
        }
      }

      const setOnInsert = {
        email,
        clientID: clientId,
        dateSubscribed,
      };

      operations.push({
        updateOne: {
          filter: { email, clientID: clientId },
          update: {
            $setOnInsert: setOnInsert,
            $set: {
              isActive: true,
              name: String(sub.name || '').trim(),
            },
          },
          upsert: true,
        },
      });
    }

    if (operations.length === 0) {
      return { added: 0, updated: 0, total: 0, skipped: subscribers.length, errors };
    }

    try {
      const result = await EmailSubscriber.bulkWrite(operations, { ordered: false });
      return {
        added: result.upsertedCount,
        updated: result.modifiedCount,
        total: result.upsertedCount + result.modifiedCount,
        skipped: errors.length,
        errors,
      };
    } catch (error) {
      const writeErrors = error.writeErrors || [];
      const partial = error.result || {};
      const writeErrorMessages = writeErrors.map((e) => e.errmsg || e.message).filter(Boolean);

      if (partial.nUpserted !== undefined || partial.nModified !== undefined) {
        return {
          added: partial.nUpserted || 0,
          updated: partial.nModified || 0,
          total: (partial.nUpserted || 0) + (partial.nModified || 0),
          skipped: errors.length + writeErrors.length,
          errors: [...errors, ...writeErrorMessages],
        };
      }

      console.error('Error adding subscribers:', error);
      return { added: 0, updated: 0, total: 0, skipped: subscribers.length, errors: [...errors, error.message] };
    }
  }

  static async unsubscribeEmails(clientId, emails) {
    const result = await EmailSubscriber.updateMany(
      {
        clientID: clientId,
        email: { $in: emails.map((e) => e.toLowerCase()) },
      },
      { $set: { isActive: false } }
    );

    return {
      unsubscribed: result.modifiedCount,
      total: emails.length,
    };
  }

  static personalizeContent(content, recipient, clientId) {
    if (!content) return '';
    let out = String(content)
      .replace(/{{name}}/g, recipient.name || '')
      .replace(/{{email}}/g, recipient.address || '')
      .replace(/{{firstName}}/g, recipient.name?.split(' ')[0] || '');

    if (clientId && recipient?.address) {
      const unsubUrl = this.buildUnsubscribeUrl(recipient.address, clientId);
      out = this.replaceUnsubscribePlaceholders(out, unsubUrl);
    }

    return out;
  }

  static parseRecipients(recipientList) {
    let raw = recipientList;
    if (typeof raw === 'string') {
      const t = raw.trim();
      if (t.startsWith('[') || t.startsWith('{')) {
        try {
          raw = JSON.parse(t);
        } catch {
          /* comma-separated */
        }
      }
    }

    let recipients = [];
    if (typeof raw === 'string') {
      recipients = raw
        .split(',')
        .map((email) => email.trim())
        .filter(Boolean)
        .map((email) => ({ address: email, name: '' }));
    } else if (Array.isArray(raw)) {
      recipients = raw.map((recipient) => {
        if (typeof recipient === 'string') return { address: recipient, name: '' };
        return {
          address: recipient.address || recipient.email || recipient,
          name: recipient.name || '',
        };
      });
    }

    const uniqueRecipients = [];
    const seenEmails = new Set();
    for (const recipient of recipients) {
      const email = recipient.address;
      if (typeof email === 'string' && this.isValidEmail(email) && !seenEmails.has(email.toLowerCase())) {
        seenEmails.add(email.toLowerCase());
        uniqueRecipients.push({
          address: email.toLowerCase().trim(),
          name: recipient.name || '',
        });
      }
    }
    return uniqueRecipients;
  }

  static isValidEmail(email) {
    return typeof email === 'string' && email.includes('@') && email.includes('.') && email.length > 5;
  }

  static sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  static async processBatch(emails, client, newsletterData, batchNumber, totalBatches) {
    const results = { sent: 0, failed: 0, queued: 0, errors: [] };
    const host = resolveSmtpHost(client);
    const smtpPort = resolveSmtpPort(client, host);
    const enableTracking = newsletterData.enableTracking !== false;

    if (!host) {
      const msg =
        'SMTP host could not be resolved; set client smtpHost or use a business email on your mail domain.';
      for (const email of emails) {
        results.failed++;
        results.errors.push({ email: email.address, error: msg });
      }
      return results;
    }

    console.log(`📦 Processing batch ${batchNumber}/${totalBatches} (${emails.length} emails)`);

    for (const email of emails) {
      try {
        let personalizedHtml = this.personalizeContent(newsletterData.html, email, client.clientID);
        let personalizedText = this.personalizeContent(
          newsletterData.text || newsletterData.html.replace(/<[^>]*>/g, ' '),
          email,
          client.clientID
        );

        const sigMerged = mergeEmailSignature(
          personalizedHtml,
          personalizedText,
          client.emailSignature || ''
        );
        personalizedHtml = sigMerged.html;
        personalizedText = sigMerged.text;

        const withUnsub = this.addUnsubscribeFooter(
          personalizedHtml,
          personalizedText,
          email.address,
          client.clientID
        );
        personalizedHtml = withUnsub.html;
        personalizedText = withUnsub.text;

        personalizedHtml = this.appendTrackingPixel(
          personalizedHtml,
          client.clientID,
          newsletterData.newsletterId,
          email.address,
          enableTracking
        );

        const attachments = (newsletterData.attachments || []).map((att) => ({
          filename: att.filename,
          content: att.content,
          contentType: att.contentType || 'application/octet-stream',
        }));

        const mailResult = await sendMailWithRetry(
          {
            host,
            port: smtpPort,
            secure: resolveSmtpSecure(smtpPort),
            user: client.businessEmail,
            pass: client.businessEmailPassword,
            from: `"${client.companyName}" <${client.businessEmail}>`,
            to: email.address,
            subject: newsletterData.subject,
            text: personalizedText,
            html: personalizedHtml,
            attachments,
            clientID: client.clientID,
            saveToSent: false,
            isNewsletter: true,
            newsletterId: newsletterData.newsletterId,
            newsletterRecipient: email.name || '',
          },
          3
        );

        if (mailResult && mailResult.queuedToOutbox) results.queued++;
        else results.sent++;
        await this.sleep(RATE_LIMITS.EMAIL_DELAY);
      } catch (error) {
        results.failed++;
        results.errors.push({ email: email.address, error: error.message });
        console.error(`❌ Failed to send to ${email.address}:`, error.message);
      }
    }

    return results;
  }

  static async sendNewsletter(client, newsletterData, options = {}) {
    const { useSubscribers = true, customRecipients = [] } = options;

    let recipients = [];
    if (useSubscribers) {
      recipients = await this.getSubscribers(client.clientID, { activeOnly: true });
      if (recipients.length === 0) throw new Error('No active subscribers found');
    } else {
      recipients = this.parseRecipients(customRecipients);
      if (recipients.length === 0) throw new Error('No valid email addresses found');
    }

    const rateLimit = this.checkRateLimit(client.clientID);
    if (!rateLimit.canSend) {
      throw new Error(
        `Rate limit exceeded. Hourly: ${rateLimit.hourly}/${RATE_LIMITS.HOURLY_LIMIT}, Daily: ${rateLimit.daily}/${RATE_LIMITS.DAILY_LIMIT}`
      );
    }

    const totalRecipients = recipients.length;
    const totalBatches = Math.ceil(totalRecipients / RATE_LIMITS.BATCH_SIZE);
    const newsletterId = newsletterData.newsletterId || `newsletter_${Date.now()}`;

    console.log(`📨 Starting newsletter to ${totalRecipients} recipients in ${totalBatches} batches`);

    let totalSent = 0;
    let totalFailed = 0;
    let totalQueued = 0;
    const allErrors = [];

    for (let i = 0; i < totalBatches; i++) {
      const startIdx = i * RATE_LIMITS.BATCH_SIZE;
      const batch = recipients.slice(startIdx, startIdx + RATE_LIMITS.BATCH_SIZE);

      const batchResults = await this.processBatch(
        batch,
        client,
        { ...newsletterData, newsletterId },
        i + 1,
        totalBatches
      );

      totalSent += batchResults.sent;
      totalFailed += batchResults.failed;
      totalQueued += batchResults.queued || 0;
      allErrors.push(...batchResults.errors);

      if (i < totalBatches - 1) await this.sleep(RATE_LIMITS.BATCH_DELAY);
    }

    this.updateRateLimit(client.clientID, totalSent + totalQueued);
    console.log(`✅ Newsletter completed: ${totalSent} sent, ${totalQueued} queued for retry, ${totalFailed} failed`);

    return {
      newsletterId,
      totalRecipients,
      totalSent,
      totalQueued,
      totalFailed,
      errors: allErrors,
      rateLimit: {
        hourly: this.checkRateLimit(client.clientID).hourly,
        daily: this.checkRateLimit(client.clientID).daily,
      },
    };
  }

  static getRateLimitStatus(clientId) {
    const rateLimit = this.checkRateLimit(clientId);
    return {
      current: { hourly: rateLimit.hourly, daily: rateLimit.daily },
      maximum: { hourly: RATE_LIMITS.HOURLY_LIMIT, daily: RATE_LIMITS.DAILY_LIMIT },
      remaining: rateLimit.remaining,
    };
  }

  /** Batch size and delays (env: NEWSLETTER_BATCH_SIZE, NEWSLETTER_BATCH_DELAY_MS, NEWSLETTER_EMAIL_DELAY_MS). */
  static getDeliveryPacing() {
    return {
      batchSize: RATE_LIMITS.BATCH_SIZE,
      batchDelayMs: RATE_LIMITS.BATCH_DELAY,
      emailDelayMs: RATE_LIMITS.EMAIL_DELAY,
    };
  }

  static buildNewsletterOpenMatch(clientId, query = {}) {
    const match = { clientID: clientId };
    if (query.newsletterId) match.newsletterId = String(query.newsletterId);
    if (query.from || query.to) {
      match.openedAt = {};
      if (query.from) match.openedAt.$gte = new Date(query.from);
      if (query.to) match.openedAt.$lte = new Date(query.to);
    }
    return match;
  }

  /** Summary: totals, unique recipients in range, opens grouped by campaign */
  static async getOpenStatsSummary(clientId, query = {}) {
    const match = this.buildNewsletterOpenMatch(clientId, query);
    const [totalOpens, uniqueEmails, byCampaign] = await Promise.all([
      NewsletterOpen.countDocuments(match),
      NewsletterOpen.distinct('email', match),
      NewsletterOpen.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$newsletterId',
            opens: { $sum: 1 },
            emails: { $addToSet: '$email' },
            lastOpen: { $max: '$openedAt' },
          },
        },
        {
          $project: {
            _id: 0,
            newsletterId: '$_id',
            opens: 1,
            uniqueRecipients: { $size: '$emails' },
            lastOpen: 1,
          },
        },
        { $sort: { lastOpen: -1 } },
        { $limit: 100 },
      ]),
    ]);
    return {
      filters: {
        newsletterId: query.newsletterId || null,
        from: query.from || null,
        to: query.to || null,
      },
      totalOpens,
      uniqueRecipients: uniqueEmails.length,
      byCampaign,
    };
  }

  /** Paginated raw open events (tracking pixel) */
  static async listNewsletterOpens(clientId, query = {}) {
    const match = this.buildNewsletterOpenMatch(clientId, query);
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 50));
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      NewsletterOpen.find(match).sort({ openedAt: -1 }).skip(skip).limit(limit).lean(),
      NewsletterOpen.countDocuments(match),
    ]);
    return {
      items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 0,
      },
    };
  }

  /** Record a verified open (tracking pixel) */
  static async recordOpen(clientId, newsletterId, email, userAgent = '') {
    await NewsletterOpen.create({
      clientID: clientId,
      newsletterId,
      email: String(email).toLowerCase().trim(),
      userAgent: userAgent || '',
    });
  }
}

module.exports = NewsletterService;
