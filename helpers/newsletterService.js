// helpers/newsletterService.js
const { sendMail } = require('./mailer');
const Email = require('../models/Email');
const EmailSubscriber = require('../models/emailSubscriber');

// Rate limiting configuration
const RATE_LIMITS = {
    BATCH_SIZE: 50,
    BATCH_DELAY: 1000, // 1 second between batches
    EMAIL_DELAY: 100,  // 100ms between individual emails
    HOURLY_LIMIT: 500,
    DAILY_LIMIT: 2000
};

// In-memory rate limiting (use Redis in production)
const rateLimitStore = new Map();

class NewsletterService {
    /**
     * Check if client can send more emails
     */
    static checkRateLimit(clientId) {
        const now = Date.now();
        const hourAgo = now - (60 * 60 * 1000);
        const dayAgo = now - (24 * 60 * 60 * 1000);

        if (!rateLimitStore.has(clientId)) {
            rateLimitStore.set(clientId, []);
        }

        const clientEmails = rateLimitStore.get(clientId);
        
        // Clean old records
        const recentEmails = clientEmails.filter(timestamp => timestamp > dayAgo);
        rateLimitStore.set(clientId, recentEmails);

        const hourlyCount = recentEmails.filter(timestamp => timestamp > hourAgo).length;
        const dailyCount = recentEmails.length;

        return {
            hourly: hourlyCount,
            daily: dailyCount,
            canSend: hourlyCount < RATE_LIMITS.HOURLY_LIMIT && dailyCount < RATE_LIMITS.DAILY_LIMIT,
            remaining: {
                hourly: RATE_LIMITS.HOURLY_LIMIT - hourlyCount,
                daily: RATE_LIMITS.DAILY_LIMIT - dailyCount
            }
        };
    }

    /**
     * Update rate limit counters
     */
    static updateRateLimit(clientId, count) {
        const now = Date.now();
        const timestamps = rateLimitStore.get(clientId) || [];
        
        for (let i = 0; i < count; i++) {
            timestamps.push(now);
        }
        
        rateLimitStore.set(clientId, timestamps);
    }

    /**
     * Get active subscribers for a client
     */
    static async getSubscribers(clientId, options = {}) {
        const { limit = 0, skip = 0, activeOnly = true } = options;
        
        const query = { clientID: clientId };
        if (activeOnly) {
            query.isActive = true;
        }

        const subscribers = await EmailSubscriber.find(query)
            .select('email name dateSubscribed isActive')
            .skip(skip)
            .limit(limit)
            .sort({ dateSubscribed: -1 })
            .lean();

        return subscribers.map(sub => ({
            address: sub.email,
            name: sub.name,
            dateSubscribed: sub.dateSubscribed,
            isActive: sub.isActive
        }));
    }

    /**
     * Get subscriber count for a client
     */
    static async getSubscriberCount(clientId, activeOnly = true) {
        const query = { clientID: clientId };
        if (activeOnly) {
            query.isActive = true;
        }
        
        return await EmailSubscriber.countDocuments(query);
    }

    /**
     * Add new subscribers in bulk
     */
    static async addSubscribers(clientId, subscribers) {
        const operations = subscribers.map(sub => ({
            updateOne: {
                filter: { 
                    email: sub.email.toLowerCase(),
                    clientID: clientId 
                },
                update: {
                    $setOnInsert: {
                        email: sub.email.toLowerCase(),
                        name: sub.name || '',
                        clientID: clientId,
                        dateSubscribed: new Date()
                    },
                    $set: {
                        isActive: true,
                        name: sub.name || '' // Update name if provided
                    }
                },
                upsert: true
            }
        }));

        if (operations.length === 0) {
            return { added: 0, updated: 0, errors: [] };
        }

        try {
            const result = await EmailSubscriber.bulkWrite(operations, { ordered: false });
            return {
                added: result.upsertedCount,
                updated: result.modifiedCount,
                total: result.upsertedCount + result.modifiedCount,
                errors: []
            };
        } catch (error) {
            console.error('Error adding subscribers:', error);
            return { added: 0, updated: 0, errors: [error.message] };
        }
    }

    /**
     * Unsubscribe email addresses
     */
    static async unsubscribeEmails(clientId, emails) {
        const result = await EmailSubscriber.updateMany(
            { 
                clientID: clientId,
                email: { $in: emails.map(email => email.toLowerCase()) }
            },
            { $set: { isActive: false } }
        );

        return {
            unsubscribed: result.modifiedCount,
            total: emails.length
        };
    }

    /**
     * Process a batch of emails
     */
    static async processBatch(emails, client, newsletterData, batchNumber, totalBatches) {
        const results = {
            sent: 0,
            failed: 0,
            errors: []
        };

        console.log(`📦 Processing batch ${batchNumber}/${totalBatches} (${emails.length} emails)`);

        for (const email of emails) {
            try {
                const domain = client.return_url?.replace(/^https?:\/\//, '').split('/')[0];
                const smtpHost = client.imapHost || `mail.${domain}`;

                // Personalize email
                const personalizedHtml = this.personalizeContent(newsletterData.html, email);
                const personalizedText = this.personalizeContent(newsletterData.text || newsletterData.html, email);
                const finalHtml = personalizedHtml + `<br><br>${client.emailSignature || ''}`;

                // Add unsubscribe link
                const unsubscribeHtml = this.addUnsubscribeLink(finalHtml, email.address, client.clientID);
                const unsubscribeText = personalizedText + `\n\nUnsubscribe: ${this.generateUnsubscribeLink(email.address, client.clientID)}`;

                const info = await sendMail({
                    host: smtpHost,
                    port: 465,
                    secure: true,
                    user: client.businessEmail,
                    pass: client.businessEmailPassword,
                    from: `"${client.companyName}" <${client.businessEmail}>`,
                    to: email.address,
                    subject: newsletterData.subject,
                    text: unsubscribeText,
                    html: unsubscribeHtml,
                    attachments: newsletterData.attachments
                });

                // Save to database
                await Email.create({
                    remoteId: info.messageId,
                    from: client.businessEmail,
                    to: email.address,
                    subject: newsletterData.subject,
                    text: unsubscribeText,
                    html: unsubscribeHtml,
                    date: new Date(),
                    flags: ['\\Seen'],
                    direction: 'outbound',
                    clientID: client.clientID,
                    isNewsletter: true,
                    newsletterId: newsletterData.newsletterId,
                    recipientName: email.name
                });

                results.sent++;
                
                // Small delay between individual emails
                await this.sleep(RATE_LIMITS.EMAIL_DELAY);

            } catch (error) {
                results.failed++;
                results.errors.push({
                    email: email.address,
                    error: error.message
                });
                console.error(`❌ Failed to send to ${email.address}:`, error.message);
            }
        }

        return results;
    }

    /**
     * Personalize email content with recipient data
     */
    static personalizeContent(content, recipient) {
        if (!content) return '';
        
        let personalized = content
            .replace(/{{name}}/g, recipient.name || '')
            .replace(/{{email}}/g, recipient.address || '')
            .replace(/{{firstName}}/g, recipient.name?.split(' ')[0] || '');
            
        return personalized;
    }

    /**
     * Add unsubscribe link to HTML content
     */
    static addUnsubscribeLink(html, email, clientId) {
        const unsubscribeLink = this.generateUnsubscribeLink(email, clientId);
        const unsubscribeSection = `
            <br><br>
            <hr>
            <p style="color: #666; font-size: 12px;">
                If you no longer wish to receive these emails, 
                <a href="${unsubscribeLink}">unsubscribe here</a>.
            </p>
        `;
        
        return html + unsubscribeSection;
    }

    /**
     * Generate unsubscribe link
     */
    static generateUnsubscribeLink(email, clientId) {
        // In production, use your actual domain
        return `${process.env.BASE_URL || 'http://localhost:3000'}/api/v1/subscribers/unsubscribe?email=${encodeURIComponent(email)}&client=${clientId}`;
    }

    /**
     * Parse and validate recipient list
     */
    static parseRecipients(recipientList) {
        let recipients = [];
        
        if (typeof recipientList === 'string') {
            // Comma-separated emails
            recipients = recipientList.split(',')
                .map(email => email.trim())
                .filter(email => email)
                .map(email => ({
                    address: email,
                    name: ''
                }));
        } else if (Array.isArray(recipientList)) {
            recipients = recipientList.map(recipient => {
                if (typeof recipient === 'string') {
                    return { address: recipient, name: '' };
                }
                return {
                    address: recipient.address || recipient.email || recipient,
                    name: recipient.name || ''
                };
            });
        }

        // Remove duplicates and validate
        const uniqueRecipients = [];
        const seenEmails = new Set();
        
        for (const recipient of recipients) {
            const email = recipient.address;
            if (typeof email === 'string' && this.isValidEmail(email) && !seenEmails.has(email)) {
                seenEmails.add(email);
                uniqueRecipients.push({
                    address: email,
                    name: recipient.name || ''
                });
            }
        }

        return uniqueRecipients;
    }

    /**
     * Basic email validation
     */
    static isValidEmail(email) {
        return typeof email === 'string' && 
               email.includes('@') && 
               email.includes('.') && 
               email.length > 5;
    }

    /**
     * Sleep helper
     */
    static sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Send newsletter (main function)
     */
    static async sendNewsletter(client, newsletterData, options = {}) {
        const { 
            useSubscribers = true, 
            customRecipients = [],
            segment = 'all' // 'all', 'new', 'active'
        } = options;

        let recipients = [];

        if (useSubscribers) {
            // Get subscribers from database
            recipients = await this.getSubscribers(client.clientID, { activeOnly: true });
            
            if (recipients.length === 0) {
                throw new Error('No active subscribers found');
            }
        } else {
            // Use custom recipient list
            recipients = this.parseRecipients(customRecipients);
            
            if (recipients.length === 0) {
                throw new Error('No valid email addresses found');
            }
        }

        // Check rate limits
        const rateLimit = this.checkRateLimit(client.clientID);
        if (!rateLimit.canSend) {
            throw new Error(`Rate limit exceeded. Hourly: ${rateLimit.hourly}/${RATE_LIMITS.HOURLY_LIMIT}, Daily: ${rateLimit.daily}/${RATE_LIMITS.DAILY_LIMIT}`);
        }

        const totalRecipients = recipients.length;
        const totalBatches = Math.ceil(totalRecipients / RATE_LIMITS.BATCH_SIZE);
        const newsletterId = `newsletter_${Date.now()}`;

        console.log(`📨 Starting newsletter to ${totalRecipients} recipients in ${totalBatches} batches`);

        let totalSent = 0;
        let totalFailed = 0;
        const allErrors = [];

        // Process batches
        for (let i = 0; i < totalBatches; i++) {
            const startIdx = i * RATE_LIMITS.BATCH_SIZE;
            const endIdx = startIdx + RATE_LIMITS.BATCH_SIZE;
            const batch = recipients.slice(startIdx, endIdx);

            const batchResults = await this.processBatch(
                batch, 
                client, 
                { ...newsletterData, newsletterId }, 
                i + 1, 
                totalBatches
            );

            totalSent += batchResults.sent;
            totalFailed += batchResults.failed;
            allErrors.push(...batchResults.errors);

            // Delay between batches (except the last one)
            if (i < totalBatches - 1) {
                await this.sleep(RATE_LIMITS.BATCH_DELAY);
            }
        }

        // Update rate limit
        this.updateRateLimit(client.clientID, totalSent);

        console.log(`✅ Newsletter completed: ${totalSent} sent, ${totalFailed} failed`);

        return {
            newsletterId,
            totalRecipients,
            totalSent,
            totalFailed,
            errors: allErrors,
            rateLimit: {
                hourly: this.checkRateLimit(client.clientID).hourly,
                daily: this.checkRateLimit(client.clientID).daily
            }
        };
    }

    /**
     * Get rate limit status
     */
    static getRateLimitStatus(clientId) {
        const rateLimit = this.checkRateLimit(clientId);
        
        return {
            current: {
                hourly: rateLimit.hourly,
                daily: rateLimit.daily
            },
            maximum: {
                hourly: RATE_LIMITS.HOURLY_LIMIT,
                daily: RATE_LIMITS.DAILY_LIMIT
            },
            remaining: rateLimit.remaining
        };
    }
}

module.exports = NewsletterService;