const nodemailer = require('nodemailer');
const Product = require('../models/product');
const { decrypt } = require('../helpers/encryption'); // Add this import
const { resolveSmtpHost, resolveSmtpPort, resolveSmtpSecure } = require('../helpers/mailHost');
const { diffBookingForCustomer } = require('./bookingEmailHelpers');
const { mergeEmailSignature } = require('../helpers/signatureHtml');
const { inlineSignatureImages } = require('../helpers/mailer');
const { enqueueOutboundEmail } = require('../queues/outboundEmailQueue');
const { serializeMailOptions, deserializeMailOptions } = require('../helpers/mailQueueSerialize');
const { isNonRetryableSmtpError, isRetryableSmtpError } = require('../helpers/smtpErrors');
const {
    buildKhanaEmail,
    escapeHtml,
    infoPanel,
    warnPanel,
    neutralPanel,
    ctaButton,
} = require('../helpers/transactionalEmailLayout');
const { normalizeEmailBranding } = require('../helpers/clientEmailBranding');
const { resolveEmailBrand } = require('../helpers/emailDesignTokens');

function brandPlainName(formattedClientName) {
    return String(formattedClientName || '')
        .replace(/<[^>]+>/g, '')
        .replace(/^The\s+/i, '')
        .replace(/\s+Team$/i, '')
        .trim() || 'Khana';
}

function wrapTransactionalEmail(headline, bodyHtml, opts = {}) {
    const brand = opts.brandName || brandPlainName(opts.formattedClientName);
    const logoUrl = (opts.logoUrl || opts.emailLogoUrl || '').trim() || undefined;
    const primaryColor = opts.primaryColor || opts.emailPrimaryColor || undefined;
    return buildKhanaEmail({
        headline,
        title: opts.title || headline,
        preheader: opts.preheader || headline,
        bodyHtml,
        brandName: brand,
        logoUrl,
        showKhanaLogo: opts.showKhanaLogo === true,
        footerHtml: opts.footerHtml,
        primaryColor,
    });
}

function wrapBranding(formattedClientName, branding = '') {
    const normalized = normalizeEmailBranding(branding);
    const url = normalized.emailLogoUrl || '';
    const resolved = resolveEmailBrand({
        emailLogoUrl: url,
        emailPrimaryColor: normalized.emailPrimaryColor,
        dashboardThemeColor: normalized.dashboardThemeColor,
    });
    return {
        formattedClientName,
        ...(url ? { emailLogoUrl: url, logoUrl: url } : {}),
        primaryColor: resolved.primaryColor,
        emailPrimaryColor: resolved.primaryColor,
    };
}

/**
 * Same pipeline as the mailbox composer: merge HTML signature, then inline uploaded
 * `/public/uploads/signatures/*` images as cid: parts so Gmail / Outlook / Apple Mail render them.
 */
function buildTransactionalMailParts(html, text, emailSignature) {
    const merged = mergeEmailSignature(
        html || '',
        text || '',
        String(emailSignature == null ? '' : emailSignature).trim()
    );
    const { html: htmlOut, attachments } = inlineSignatureImages(merged.html, []);
    const textOut =
        merged.text ||
        (htmlOut || '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]*>/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    return { html: htmlOut, text: textOut, attachments };
}

/** Spread into nodemailer `sendMail` options: html, text, attachments (signature images as cid). */
function mimeFrom(html, text, emailSignature) {
    const p = buildTransactionalMailParts(html, text, emailSignature);
    return { html: p.html, text: p.text, attachments: p.attachments || [] };
}

/** Small pause between two SMTP messages in one request (customer + merchant copy, etc.). Not a “cooldown” lock — avoids some hosts dropping rapid reuse. */
async function smtpBetweenMessagesGap() {
    const raw = process.env.SMTP_BETWEEN_MESSAGES_MS;
    const ms = raw === undefined || raw === '' ? 450 : Math.max(0, parseInt(String(raw), 10) || 0);
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

async function closeTransporterQuietly(transporter) {
    if (!transporter || typeof transporter.close !== 'function') return;
    try {
        await Promise.resolve(transporter.close());
    } catch (_) {
        /* ignore */
    }
}

function qBooking(booking) {
    const id = booking && booking.clientID;
    return id ? { clientID: String(id) } : null;
}

function qTenant(tenantClientId) {
    return tenantClientId ? { clientID: String(tenantClientId) } : null;
}

function decryptAddressValue(value) {
    if (!value) return value;

    if (Array.isArray(value)) {
        return value.map((entry) => decryptAddressValue(entry));
    }

    if (typeof value === 'string') {
        return decrypt(value);
    }

    if (typeof value === 'object') {
        const copy = { ...value };
        if (typeof copy.address === 'string') {
            copy.address = decrypt(copy.address);
        }
        return copy;
    }

    return value;
}

function normalizeMailRecipients(mailOptions) {
    if (!mailOptions || typeof mailOptions !== 'object') return mailOptions;
    return {
        ...mailOptions,
        from: decryptAddressValue(mailOptions.from),
        to: decryptAddressValue(mailOptions.to),
        cc: decryptAddressValue(mailOptions.cc),
        bcc: decryptAddressValue(mailOptions.bcc),
        replyTo: decryptAddressValue(mailOptions.replyTo),
    };
}

/**
 * Used by emailOutboxWorker after loading tenant SMTP credentials from Mongo.
 */
async function deliverQueuedOutboundEmail(bEmail, BEPass, mailOptionsSerialized) {
    const mailOptions = deserializeMailOptions(mailOptionsSerialized);
    return sendWithRetry(() => createTransporter(bEmail, BEPass), mailOptions, 5, 1600, null);
}

/**
 * @param {() => import('nodemailer').Transporter | import('nodemailer').Transporter} getTransporter - factory recommended so each attempt can use a clean socket after ECONNRESET
 * @param {object} mailOptions
 * @param {number} retries
 * @param {number} delayMs
 * @param {{ clientID: string, label?: string } | null} queueMeta - when SMTP still fails after retries, enqueue for delayed resend (Agenda)
 */
async function sendWithRetry(getTransporter, mailOptions, retries = 5, delayMs = 1600, queueMeta = null) {
    const factory = typeof getTransporter === 'function' ? getTransporter : () => getTransporter;
    const normalizedMailOptions = normalizeMailRecipients(mailOptions);

    for (let attempt = 1; attempt <= retries; attempt++) {
        const transporter = factory();
        try {
            const result = await transporter.sendMail(normalizedMailOptions);
            await closeTransporterQuietly(transporter);

            if (attempt > 1) {
                console.log(`✅ Email delivered successfully after ${attempt} attempts`);
            } else {
                console.log(`✅ Email sent successfully on first attempt`);
            }

            return result;
        } catch (err) {
            await closeTransporterQuietly(transporter);

            if (isNonRetryableSmtpError(err)) {
                console.error(`💥 SMTP error (not retrying):`, err.message);
                throw err;
            }

            if (!isRetryableSmtpError(err)) {
                console.error(`💥 SMTP error (giving up):`, err.message);
                throw err;
            }

            if (attempt === retries) {
                console.error(`💥 Final email attempt failed:`, err.message);
                if (queueMeta && queueMeta.clientID) {
                    try {
                        await enqueueOutboundEmail({
                            clientID: queueMeta.clientID,
                            mailOptions: serializeMailOptions(normalizedMailOptions),
                            label: queueMeta.label || '',
                            lastError: err.message,
                        });
                        return null;
                    } catch (qErr) {
                        console.error('Failed to enqueue outbound email:', qErr.message);
                    }
                }
                throw new Error('Failed to send email after multiple attempts.');
            }

            console.log(`🔄 Email attempt ${attempt} failed (${err.message}), retrying in ${delayMs / 1000}s...`);
            await new Promise((res) => setTimeout(res, delayMs));
            delayMs *= 1.55;
        }
    }
}

function getFormattedClientName(clientName) {
    return clientName
        ? 'The ' + clientName.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase()).trim() + ' Team'
        : 'The Khana Technologies Team';
}

function createTransporter(bEmail, BEPass) {
    const decryptedEmail = decrypt(bEmail);
    const decryptedPass = decrypt(BEPass);

    const host = resolveSmtpHost({ businessEmail: decryptedEmail });
    const port = resolveSmtpPort({ businessEmail: decryptedEmail }, host);
    const secure = resolveSmtpSecure(port);

    return nodemailer.createTransport({
        host,
        port,
        secure,
        requireTLS: port === 587,
        auth: {
            user: decryptedEmail,
            pass: decryptedPass
        },
        tls: {
            rejectUnauthorized: false,
            minVersion: 'TLSv1.2'
        },
        // Pooled reuse can hit ECONNRESET when the host closes idle sockets; fresh transport per send is safer for bursty booking mail.
        pool: false,
        connectionTimeout: 30000,
        greetingTimeout: 30000,
        socketTimeout: 60000,
    });
}

function formatBookingDate(date) {
    return new Date(date).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

// -----------------------------
// Booking updated (moved / edited) — customer notification
// -----------------------------
async function sendBookingUpdateNotificationEmail(booking, changeRows, bEmail, BEPass, clientName, options = {}) {
    if (!changeRows || changeRows.length === 0) return;
    const {
        reason = '',
        toEmail,
        emailSignature = '',
        emailLogoUrl = '',
        emailPrimaryColor = '',
        dashboardThemeColor = '',
        branding: brandingOpt,
    } = options;
    const branding = brandingOpt || { emailLogoUrl, emailPrimaryColor, dashboardThemeColor };
    const recipient = toEmail || booking.customerEmail;
    if (!recipient) return;

    const formattedClientName = getFormattedClientName(clientName);
    const formattedDate = formatBookingDate(booking.date);
    const servicesList = (booking.services || []).map((service) => `<li>${escapeHtml(service)}</li>`).join('');

    const rowsHtml = changeRows
        .map(
            (r) => `
        <tr>
            <td style="padding:8px;border:1px solid #e5e7eb;"><strong>${escapeHtml(r.label)}</strong></td>
            <td style="padding:8px;border:1px solid #e5e7eb;color:#6b7280;">${escapeHtml(r.from)}</td>
            <td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(r.to)}</td>
        </tr>`
        )
        .join('');

    const emailContent = wrapTransactionalEmail(
        'Your booking was updated',
        `
            <p style="margin:0 0 16px;">Hi ${escapeHtml(booking.customerName)},</p>
            <p style="margin:0 0 16px;">We adjusted your booking details. Below is a summary of what changed and your <strong>current</strong> booking information.</p>
            ${reason ? `<p style="margin:0 0 16px;"><strong>Note from the business:</strong> ${escapeHtml(reason)}</p>` : ''}

            <div style="margin: 0 0 20px; padding: 16px; background-color: #fffbeb; border: 1px solid #fde68a; border-radius: 8px;">
                <h3 style="margin:0 0 12px;font-size:14px;color:#92400e;">Changes</h3>
                <table style="width:100%;border-collapse:collapse;font-size:14px;">
                    <thead>
                        <tr style="background:#f3f4f6;">
                            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left;">Field</th>
                            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left;">Before</th>
                            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left;">After</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>

            ${infoPanel({
                title: 'Current booking',
                rows: [
                    ['Date', escapeHtml(formattedDate)],
                    ['Time', `${escapeHtml(booking.time || '')}${booking.endTime ? ` – ${escapeHtml(booking.endTime)}` : ''}`],
                    ['Status', escapeHtml(booking.status || '')],
                ],
                html: `<p style="margin:0 0 8px;"><strong>Services:</strong></p><ul style="margin:0;padding-left:20px;">${servicesList}</ul>`,
            })}

            <p style="margin:0 0 16px;">If something looks wrong, reply to this email or call us.</p>
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
        `,
        { ...wrapBranding(formattedClientName, branding) }
    );

    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decrypt(bEmail),
            to: recipient,
            subject: `Booking updated — ${formattedDate}`,
            ...mimeFrom(emailContent, '', emailSignature),
        },
        5,
        1600,
        qBooking(booking)
    );
    console.log('Booking update notification email sent');
}

/** When the booking email address changes, notify the previous address once. */
async function sendBookingEmailReassignedNotice(prevEmail, booking, bEmail, BEPass, clientName, emailSignature = '', branding = '') {
    if (!prevEmail) return;
    const formattedClientName = getFormattedClientName(clientName);
    const html = wrapTransactionalEmail(
        'Booking notifications moved',
        `
            <p style="margin:0 0 16px;">This address is no longer the primary contact on a booking for <strong>${escapeHtml(booking.customerName || 'a guest')}</strong>.</p>
            <p style="margin:0 0 16px;">Future updates will be sent to: <strong>${escapeHtml(booking.customerEmail)}</strong>.</p>
            <p style="margin:0 0 16px;">If you did not request this change, please contact ${formattedClientName.replace(/<[^>]+>/g, '')}.</p>
            <p style="margin:0;">${formattedClientName}</p>
        `,
        { ...wrapBranding(formattedClientName, branding) }
    );
    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decrypt(bEmail),
            to: prevEmail,
            subject: 'Booking contact email updated',
            ...mimeFrom(html, '', emailSignature),
        },
        5,
        1600,
        qBooking(booking)
    );
}

// -----------------------------
// Booking statement — paid activity record (not a payment request)
// -----------------------------
async function sendBookingStatementEmail(booking, bEmail, BEPass, clientName, emailSignature = '', branding = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const formattedDate = formatBookingDate(booking.date);
    const servicesList = (booking.services || []).map((service) => `<li>${escapeHtml(service)}</li>`).join('');
    const pay = booking.payment || {};
    const status = pay.status || 'pending';
    const amount = pay.amount != null ? `R${Number(pay.amount).toFixed(2)}` : '—';
    const deposit = pay.depositAmount != null ? `R${Number(pay.depositAmount).toFixed(2)}` : '';
    const balance = pay.balanceDue != null ? `R${Number(pay.balanceDue).toFixed(2)}` : '';

    const emailContent = wrapTransactionalEmail(
        'Booking statement',
        `
            <p style="margin:0 0 16px;">Hi ${escapeHtml(booking.customerName)},</p>
            <p style="margin:0 0 16px;">Here is a summary of your booking and any recorded payment — <strong>for your records only</strong>. This is <strong>not</strong> a bill and <strong>no action is required</strong> unless we have contacted you separately.</p>
            ${neutralPanel({
                title: 'Record only',
                html: '<p style="margin:0;color:#047857;"><strong>Not a payment request.</strong></p>',
            })}
            ${neutralPanel({
                title: 'Booking',
                html: `
                    <p style="margin:0 0 8px;"><strong>Date:</strong> ${escapeHtml(formattedDate)}</p>
                    <p style="margin:0 0 8px;"><strong>Time:</strong> ${escapeHtml(booking.time || '')}${booking.endTime ? ` – ${escapeHtml(booking.endTime)}` : ''}</p>
                    <p style="margin:0 0 8px;"><strong>Services:</strong></p><ul style="margin:0;padding-left:20px;">${servicesList}</ul>
                    <p style="margin:8px 0 0;"><strong>Booking status:</strong> ${escapeHtml(booking.status || '')}</p>
                `,
            })}
            ${infoPanel({
                title: 'Payment on file',
                html: `
                    <p style="margin:0 0 8px;"><strong>Payment status:</strong> ${escapeHtml(status)}</p>
                    <p style="margin:0 0 8px;"><strong>Recorded amount:</strong> ${escapeHtml(amount)}</p>
                    ${deposit ? `<p style="margin:0 0 8px;"><strong>Deposit recorded:</strong> ${escapeHtml(deposit)}</p>` : ''}
                    ${balance ? `<p style="margin:0 0 8px;"><strong>Balance noted:</strong> ${escapeHtml(balance)}</p>` : ''}
                    ${pay.transactionId ? `<p style="margin:0 0 8px;"><strong>Reference / transaction id:</strong> ${escapeHtml(String(pay.transactionId))}</p>` : ''}
                    ${pay.paidAt ? `<p style="margin:0;"><strong>Recorded paid at:</strong> ${escapeHtml(new Date(pay.paidAt).toLocaleString())}</p>` : ''}
                `,
            })}
            <p style="margin:0 0 16px;">Questions? Reply to this email.</p>
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
        `,
        { ...wrapBranding(formattedClientName, branding) }
    );

    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decrypt(bEmail),
            to: booking.customerEmail,
            subject: `Your booking summary — ${formattedDate}`,
            ...mimeFrom(emailContent, '', emailSignature),
        },
        5,
        1600,
        qBooking(booking)
    );
    console.log('Booking statement email sent');
}

// -----------------------------
// Booking Confirmation Email
// -----------------------------
async function sendBookingConfirmationEmail(booking, bEmail, BEPass, clientName, emailSignature = '', branding = '') {
    console.log('Sending booking confirmation with decrypted credentials');
    const formattedClientName = getFormattedClientName(clientName);
    const formattedDate = formatBookingDate(booking.date);

    const servicesList = booking.services.map(service => `<li>${escapeHtml(service)}</li>`).join('');

    const emailContent = wrapTransactionalEmail(
        'Booking confirmed!',
        `
            <p style="margin:0 0 16px;">Hi ${escapeHtml(booking.customerName)},</p>
            <p style="margin:0 0 16px;">Your booking has been confirmed. We're looking forward to seeing you!</p>
            ${infoPanel({
                title: 'Booking details',
                html: `
                    <p style="margin:0 0 8px;"><strong>Date:</strong> ${escapeHtml(formattedDate)}</p>
                    <p style="margin:0 0 8px;"><strong>Time:</strong> ${escapeHtml(booking.time)} – ${escapeHtml(booking.endTime)}</p>
                    <p style="margin:0 0 8px;"><strong>Services:</strong></p><ul style="margin:0;padding-left:20px;">${servicesList}</ul>
                    ${booking.notes ? `<p style="margin:8px 0 0;"><strong>Notes:</strong> ${escapeHtml(booking.notes)}</p>` : ''}
                    ${booking.payment.amount ? `<p style="margin:8px 0 0;"><strong>Amount:</strong> R${escapeHtml(booking.payment.amount)}</p>` : ''}
                `,
            })}
            ${warnPanel({
                title: 'Location & preparation',
                html: '<p style="margin:0 0 8px;">Please arrive 10 minutes before your scheduled time.</p><p style="margin:0;">If you need to reschedule or cancel, please contact us at least 24 hours in advance.</p>',
            })}
            <p style="margin:0 0 16px;">If you have any questions, feel free to reply to this email.</p>
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
        `,
        { ...wrapBranding(formattedClientName, branding) }
    );

    const parts = buildTransactionalMailParts(emailContent, '', emailSignature);
    const qm = qBooking(booking);
    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decrypt(bEmail), // Decrypt for the from field
            to: booking.customerEmail,
            subject: `Booking Confirmation - ${formattedDate}`,
            html: parts.html,
            text: parts.text,
            attachments: parts.attachments || [],
        },
        5,
        1600,
        qm
    );

    await smtpBetweenMessagesGap();

    // Send notification to business
    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decrypt(bEmail), // Decrypt for the from field
            to: decrypt(bEmail), // Decrypt for the to field
            subject: `New Booking - ${booking.customerName}`,
            html: parts.html,
            text: parts.text,
            attachments: parts.attachments || [],
        },
        5,
        1600,
        qm
    );

    console.log('Booking confirmation email sent successfully');
}

// -----------------------------
// Booking Reminder Email
// -----------------------------
async function sendBookingReminderEmail(booking, bEmail, BEPass, clientName, emailSignature = '', branding = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const formattedDate = formatBookingDate(booking.date);

    const servicesList = booking.services.map(service => `<li>${escapeHtml(service)}</li>`).join('');

    const emailContent = wrapTransactionalEmail(
        'Booking reminder',
        `
            <p style="margin:0 0 16px;">Hi ${escapeHtml(booking.customerName)},</p>
            <p style="margin:0 0 16px;">This is a friendly reminder about your booking scheduled for tomorrow.</p>
            ${infoPanel({
                title: 'Booking details',
                html: `
                    <p style="margin:0 0 8px;"><strong>Date:</strong> ${escapeHtml(formattedDate)}</p>
                    <p style="margin:0 0 8px;"><strong>Time:</strong> ${escapeHtml(booking.time)} – ${escapeHtml(booking.endTime)}</p>
                    <p style="margin:0 0 8px;"><strong>Services:</strong></p><ul style="margin:0;padding-left:20px;">${servicesList}</ul>
                `,
            })}
            ${neutralPanel({
                title: 'Tips for your visit',
                html: '<p style="margin:0 0 6px;">• Please arrive 10 minutes early</p><p style="margin:0 0 6px;">• Bring any necessary documents or items</p><p style="margin:0;">• Contact us if you\'re running late</p>',
            })}
            <p style="margin:0 0 16px;">We're looking forward to seeing you!</p>
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
        `,
        { ...wrapBranding(formattedClientName, branding) }
    );

    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decrypt(bEmail), // Decrypt for the from field
            to: booking.customerEmail,
            subject: `Reminder: Your Booking Tomorrow - ${formattedDate}`,
            ...mimeFrom(emailContent, '', emailSignature),
        },
        5,
        1600,
        qBooking(booking)
    );

    console.log('Booking reminder email sent successfully');
}

// -----------------------------
// Payment Confirmation Email
// -----------------------------
async function sendPaymentConfirmationEmail(booking, bEmail, BEPass, clientName, emailSignature = '', branding = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const formattedDate = formatBookingDate(booking.date);

    const emailContent = wrapTransactionalEmail(
        'Payment confirmed',
        `
            <p style="margin:0 0 16px;">Hi ${escapeHtml(booking.customerName)},</p>
            <p style="margin:0 0 16px;">Your payment for the upcoming booking has been successfully processed.</p>
            ${infoPanel({
                title: 'Payment details',
                rows: [
                    ['Amount', `R${escapeHtml(booking.payment.amount)}`],
                    ['Date', escapeHtml(new Date(booking.payment.paidAt).toLocaleDateString())],
                    ['Transaction ID', escapeHtml(booking.payment.transactionId)],
                ],
            })}
            ${infoPanel({
                title: 'Booking details',
                rows: [
                    ['Date', escapeHtml(formattedDate)],
                    ['Time', `${escapeHtml(booking.time)} – ${escapeHtml(booking.endTime)}`],
                    ['Services', escapeHtml(booking.services.join(', '))],
                ],
            })}
            <p style="margin:0 0 16px;">Your booking is now confirmed and we're looking forward to seeing you!</p>
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
        `,
        { ...wrapBranding(formattedClientName, branding) }
    );

    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decrypt(bEmail), // Decrypt for the from field
            to: booking.customerEmail,
            subject: `Payment Confirmed - Booking ${formattedDate}`,
            ...mimeFrom(emailContent, '', emailSignature),
        },
        5,
        1600,
        qBooking(booking)
    );

    console.log('Payment confirmation email sent successfully');
}

// -----------------------------
// Booking Cancellation Email
// -----------------------------
async function sendBookingCancellationEmail(booking, bEmail, BEPass, clientName, reason = '', emailSignature = '', branding = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const formattedDate = formatBookingDate(booking.date);

    const emailContent = wrapTransactionalEmail(
        'Booking cancelled',
        `
            <p style="margin:0 0 16px;">Hi ${escapeHtml(booking.customerName)},</p>
            <p style="margin:0 0 16px;">Your booking has been cancelled.</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 20px;">
              <tr><td style="padding:16px 18px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">
                <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#991b1b;">Cancelled booking</p>
                <p style="margin:0 0 8px;"><strong>Date:</strong> ${escapeHtml(formattedDate)}</p>
                <p style="margin:0 0 8px;"><strong>Time:</strong> ${escapeHtml(booking.time)}</p>
                <p style="margin:0 0 8px;"><strong>Services:</strong> ${escapeHtml(booking.services.join(', '))}</p>
                ${reason ? `<p style="margin:0;"><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : ''}
              </td></tr>
            </table>
            ${booking.payment.status === 'paid' ? warnPanel({
                title: 'Refund information',
                html: '<p style="margin:0;">Your payment will be refunded within 5–7 business days.</p>',
            }) : ''}
            <p style="margin:0 0 16px;">We hope to see you again in the future!</p>
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
        `,
        { ...wrapBranding(formattedClientName, branding) }
    );

    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decrypt(bEmail), // Decrypt for the from field
            to: booking.customerEmail,
            subject: `Booking Cancelled - ${formattedDate}`,
            ...mimeFrom(emailContent, '', emailSignature),
        },
        5,
        1600,
        qBooking(booking)
    );

    console.log('Booking cancellation email sent successfully');
}

// -----------------------------
// Booking Rescheduling Email
// -----------------------------
async function sendReschedulingEmail(booking, oldDetails, bEmail, BEPass, clientName, reason, emailSignature = '', branding = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const newFormattedDate = formatBookingDate(booking.date);
    const oldFormattedDate = formatBookingDate(oldDetails.date);

    const emailContent = wrapTransactionalEmail(
        'Booking rescheduled',
        `
            <p style="margin:0 0 16px;">Hi ${escapeHtml(booking.customerName)},</p>
            <p style="margin:0 0 16px;">Your booking has been successfully rescheduled.</p>
            ${warnPanel({
                title: 'Previous booking',
                html: `
                    <p style="margin:0 0 8px;"><strong>Date:</strong> ${escapeHtml(oldFormattedDate)}</p>
                    <p style="margin:0 0 8px;"><strong>Time:</strong> ${escapeHtml(oldDetails.time)} – ${escapeHtml(oldDetails.endTime)}</p>
                    ${reason ? `<p style="margin:0;"><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : ''}
                `,
            })}
            ${infoPanel({
                title: 'New booking details',
                rows: [
                    ['Date', escapeHtml(newFormattedDate)],
                    ['Time', `${escapeHtml(booking.time)} – ${escapeHtml(booking.endTime)}`],
                    ['Services', escapeHtml(booking.services.join(', '))],
                ],
            })}
            <p style="margin:0 0 16px;">We look forward to seeing you at your new scheduled time!</p>
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
        `,
        { ...wrapBranding(formattedClientName, branding) }
    );

    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decrypt(bEmail), // Decrypt for the from field
            to: booking.customerEmail,
            subject: `Booking Rescheduled - ${newFormattedDate}`,
            ...mimeFrom(emailContent, '', emailSignature),
        },
        5,
        1600,
        qBooking(booking)
    );

    console.log('Booking rescheduling email sent successfully');
}

// -----------------------------
// Order Confirmation Email
// -----------------------------
async function sendOrderConfirmationEmail(
    clientEmail,
    orderItems,
    bEmail,
    BEPass,
    shipping,
    clientName,
    orderID,
    emailSignature = '',
    branding = '',
    tenantClientId = null
) {
    const formattedClientName = getFormattedClientName(clientName);
    async function populateOrderItems(items) {
        return Promise.all(items.map(async item => {
            const populatedItem = await Product.findById(item.product);
            return { ...item, product: populatedItem };
        }));
    }

    const populatedOrderItems = await populateOrderItems(orderItems);
    const parentOrder = populatedOrderItems[0]?.$__?.parent;

    const orderItemsHtml = populatedOrderItems.map(item => {
        const variant = item._doc.variant;
        const variantHtml = (variant && variant !== 'Default') 
            ? `<div style="color: #777; font-size: 13px; margin-top: 4px;"><em>Variant:</em> ${variant}</div>` 
            : '';
        return `
            <tr>
                <td style="padding: 10px; border: 1px solid #ddd;">
                    <img src="${item.product.images[0]}" alt="${item.product.productName}" style="height: 80px; border-radius: 8px;">
                </td>
                <td style="padding: 10px; border: 1px solid #ddd;">
                    <div><strong>${item.product.productName}</strong></div>${variantHtml}
                </td>
                <td style="padding: 10px; border: 1px solid #ddd;">${item._doc.quantity}</td>
                <td style="padding: 10px; border: 1px solid #ddd;">R${item._doc.variantPrice}</td>
                <td style="padding: 10px; border: 1px solid #ddd;">R${(item._doc.quantity * item._doc.variantPrice).toFixed(2)}</td>
            </tr>
        `;
    }).join('');

    const subtotal = populatedOrderItems.reduce((total, item) => total + (item._doc.quantity * item._doc.variantPrice), 0);
    const total = subtotal + shipping;

    const decryptedEmail = decrypt(bEmail); // Decrypt once for reuse

    const emailContent = wrapTransactionalEmail(
        'Thank you for your order!',
        `
            <p style="margin:0 0 16px;">Hi there,</p>
            <p style="margin:0 0 16px;">We're thrilled you've chosen to shop with us. Here's your order summary:</p>
            ${infoPanel({ title: 'Order ID', html: `<p style="margin:0;">${escapeHtml(orderID)}</p>` })}
            ${neutralPanel({
                title: 'Delivery address',
                html: `
                    <p style="margin:0 0 8px;"><strong>Name:</strong> ${escapeHtml(parentOrder.customer.customerFirstName)} ${escapeHtml(parentOrder.customer.customerLastName)}</p>
                    <p style="margin:0 0 8px;"><strong>Address:</strong> ${escapeHtml(parentOrder.address)}</p>
                    <p style="margin:0;"><strong>Postal code:</strong> ${escapeHtml(parentOrder.postalCode)}</p>
                `,
            })}
            <table style="width:100%;border-collapse:collapse;margin:0 0 20px;font-size:14px;">
                <thead>
                    <tr style="background-color:#f5f5f5;">
                        <th style="padding:10px;border:1px solid #ddd;"></th>
                        <th style="padding:10px;border:1px solid #ddd;text-align:left;">Product</th>
                        <th style="padding:10px;border:1px solid #ddd;text-align:left;">Qty</th>
                        <th style="padding:10px;border:1px solid #ddd;text-align:left;">Price</th>
                        <th style="padding:10px;border:1px solid #ddd;text-align:left;">Total</th>
                    </tr>
                </thead>
                <tbody>${orderItemsHtml}</tbody>
            </table>
            <p style="margin:0 0 8px;"><strong>Subtotal:</strong> R${subtotal.toFixed(2)}</p>
            <p style="margin:0 0 8px;"><strong>Shipping:</strong> R${shipping.toFixed(2)}</p>
            <p style="margin:0 0 20px;font-size:18px;"><strong>Total price:</strong> R${total.toFixed(2)}</p>
            <p style="margin:0 0 16px;">If you have any questions, feel free to reply to this email.</p>
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
        `,
        {
            formattedClientName,
            footerHtml: `This email confirms your recent purchase from ${escapeHtml(brandPlainName(formattedClientName))}.`,
        }
    );

    const parts = buildTransactionalMailParts(emailContent, '', emailSignature);
    const qOrder = qTenant(tenantClientId);
    // Send to client and business
    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decryptedEmail,
            to: clientEmail,
            subject: 'Order Confirmation',
            html: parts.html,
            text: parts.text,
            attachments: parts.attachments || [],
        },
        5,
        1600,
        qOrder
    );
    await smtpBetweenMessagesGap();
    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decryptedEmail,
            to: decryptedEmail,
            subject: 'New Order Received',
            html: parts.html,
            text: parts.text,
            attachments: parts.attachments || [],
        },
        5,
        1600,
        qOrder
    );

    console.log('Order confirmation email sent successfully');
}

// -----------------------------
// Order Status Update Email
// -----------------------------
async function sendOrderStatusUpdateEmail(
    clientEmail,
    customerName,
    status,
    orderID,
    websiteURL,
    bEmail,
    BEPass,
    clientName,
    trackingID,
    trackingLink,
    emailSignature = '',
    branding = '',
    tenantClientId = null
) {
    const formattedClientName = getFormattedClientName(clientName);

    const statusMessages = {
        processed: { subject: 'Your Order Has Been Processed', message: 'We\'ve finished preparing your order and it\'s now processed. It will be shipped soon.' },
        shipped: { subject: 'Your Order Has Been Shipped', message: 'Good news! Your order has been shipped. You can track it below.' },
        delivered: { subject: 'Your Order Has Been Delivered', message: 'Your order has been marked as delivered. We hope you enjoy your purchase!' }
    };

    const { subject, message } = statusMessages[status.toLowerCase()] || { subject: 'Order Update', message: 'There\'s an update regarding your order.' };

    const decryptedEmail = decrypt(bEmail);

    const viewOrderLink = `${websiteURL}/login`;
    const trackOrderLink = `${trackingLink || viewOrderLink}`;

    const emailContent = wrapTransactionalEmail(
        `Order update: ${status.toUpperCase()}`,
        `
            <p style="margin:0 0 16px;">Hi ${escapeHtml(customerName)},</p>
            <p style="margin:0 0 16px;">${escapeHtml(message)}</p>
            ${infoPanel({ title: 'Order ID', html: `<p style="margin:0;">${escapeHtml(orderID)}</p>` })}
            ${ctaButton({ href: viewOrderLink, label: 'View my order' })}
            ${status === 'shipped' ? ctaButton({ href: trackOrderLink, label: 'Track my order' }) : ''}
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
        `,
        { ...wrapBranding(formattedClientName, branding) }
    );

    const parts = buildTransactionalMailParts(emailContent, '', emailSignature);
    const qOrder = qTenant(tenantClientId);
    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decryptedEmail,
            to: clientEmail,
            subject,
            html: parts.html,
            text: parts.text,
            attachments: parts.attachments || [],
        },
        5,
        1600,
        qOrder
    );
    await smtpBetweenMessagesGap();
    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decryptedEmail,
            to: decryptedEmail,
            subject,
            html: parts.html,
            text: parts.text,
            attachments: parts.attachments || [],
        },
        5,
        1600,
        qOrder
    );

    console.log(`Order status email (${status}) sent successfully`);
}

// -----------------------------
// Accommodation Confirmation Email
// -----------------------------
async function sendAccommodationConfirmationEmail(booking, bEmail, BEPass, clientName, emailSignature = '', branding = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const decryptedEmail = decrypt(bEmail);
    
    const checkInDate = formatBookingDate(booking.accommodation.checkIn);
    const checkOutDate = formatBookingDate(booking.accommodation.checkOut);

    const emailContent = wrapTransactionalEmail(
        'Accommodation confirmed',
        `
            <p style="margin:0 0 16px;">Hi ${escapeHtml(booking.customerName)},</p>
            <p style="margin:0 0 16px;">Your accommodation booking has been confirmed. We look forward to hosting you!</p>
            ${infoPanel({
                title: 'Accommodation details',
                html: `
                    <p style="margin:0 0 8px;"><strong>Check-in:</strong> ${escapeHtml(checkInDate)} (from 14:00)</p>
                    <p style="margin:0 0 8px;"><strong>Check-out:</strong> ${escapeHtml(checkOutDate)} (until 11:00)</p>
                    <p style="margin:0 0 8px;"><strong>Duration:</strong> ${escapeHtml(booking.accommodation.numberOfNights)} night(s)</p>
                    <p style="margin:0 0 8px;"><strong>Guests:</strong> ${escapeHtml(booking.accommodation.numberOfGuests)}</p>
                    <p style="margin:0 0 8px;"><strong>Room type:</strong> ${escapeHtml(booking.accommodation.roomType)}</p>
                    ${booking.accommodation.specialRequests ? `<p style="margin:0;"><strong>Special requests:</strong> ${escapeHtml(booking.accommodation.specialRequests)}</p>` : ''}
                `,
            })}
            ${warnPanel({
                title: 'Location & arrival',
                html: '<p style="margin:0 0 8px;">Please bring your ID/document for check-in.</p><p style="margin:0;">Early check-in and late check-out are subject to availability.</p>',
            })}
            ${booking.payment.amount ? neutralPanel({
                title: 'Payment details',
                html: `
                    <p style="margin:0 0 8px;"><strong>Total amount:</strong> R${escapeHtml(booking.payment.amount)}</p>
                    ${booking.payment.depositAmount ? `<p style="margin:0 0 8px;"><strong>Deposit paid:</strong> R${escapeHtml(booking.payment.depositAmount)}</p>` : ''}
                    ${booking.payment.balanceDue ? `<p style="margin:0;"><strong>Balance due:</strong> R${escapeHtml(booking.payment.balanceDue)} (before ${escapeHtml(new Date(booking.payment.dueDate).toLocaleDateString())})</p>` : ''}
                `,
            }) : ''}
            <p style="margin:0 0 16px;">If you have any questions about your stay, feel free to reply to this email.</p>
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
        `,
        { ...wrapBranding(formattedClientName, branding) }
    );

    const parts = buildTransactionalMailParts(emailContent, '', emailSignature);
    const qm = qBooking(booking);
    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decryptedEmail,
            to: booking.customerEmail,
            subject: `Accommodation Confirmation - ${checkInDate} to ${checkOutDate}`,
            html: parts.html,
            text: parts.text,
            attachments: parts.attachments || [],
        },
        5,
        1600,
        qm
    );

    await smtpBetweenMessagesGap();

    // Send notification to business
    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decryptedEmail,
            to: decryptedEmail,
            subject: `New Accommodation Booking - ${booking.customerName}`,
            html: parts.html,
            text: parts.text,
            attachments: parts.attachments || [],
        },
        5,
        1600,
        qm
    );

    console.log('Accommodation confirmation email sent successfully');
}

// -----------------------------
// Mixed Booking Confirmation Email
// -----------------------------
async function sendMixedBookingConfirmationEmail(booking, bEmail, BEPass, clientName, emailSignature = '', branding = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const decryptedEmail = decrypt(bEmail);
    
    const serviceDate = formatBookingDate(booking.date);
    const checkInDate = formatBookingDate(booking.accommodation.checkIn);

    const emailContent = wrapTransactionalEmail(
        'Booking confirmed',
        `
            <p style="margin:0 0 16px;">Hi ${escapeHtml(booking.customerName)},</p>
            <p style="margin:0 0 16px;">Your combined service and accommodation booking has been confirmed!</p>
            ${infoPanel({
                title: 'Service details',
                rows: [
                    ['Date', escapeHtml(serviceDate)],
                    ['Time', `${escapeHtml(booking.time)} – ${escapeHtml(booking.endTime)}`],
                    ['Services', escapeHtml(booking.services.join(', '))],
                ],
            })}
            ${neutralPanel({
                title: 'Accommodation details',
                html: `
                    <p style="margin:0 0 8px;"><strong>Check-in:</strong> ${escapeHtml(checkInDate)}</p>
                    <p style="margin:0 0 8px;"><strong>Duration:</strong> ${escapeHtml(booking.accommodation.numberOfNights)} night(s)</p>
                    <p style="margin:0;"><strong>Room type:</strong> ${escapeHtml(booking.accommodation.roomType)}</p>
                `,
            })}
            <p style="margin:0 0 16px;">We look forward to serving you and providing a comfortable stay!</p>
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
        `,
        { ...wrapBranding(formattedClientName, branding) }
    );

    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decryptedEmail,
            to: booking.customerEmail,
            subject: `Booking Confirmation - Services & Accommodation`,
            ...mimeFrom(emailContent, '', emailSignature),
        },
        5,
        1600,
        qBooking(booking)
    );

    console.log('Mixed booking confirmation email sent successfully');
}

// -----------------------------
// Reset Password Email
// -----------------------------
async function sendResetPasswordEmail(
    clientEmail,
    customerName,
    websiteURL,
    resetLink,
    bEmail,
    BEPass,
    clientName,
    emailSignature = '',
    branding = '',
    tenantClientId = null
) {
    const formattedClientName = getFormattedClientName(clientName);
    const decryptedEmail = decrypt(bEmail);
    const qm = qTenant(tenantClientId);

    const emailContent = wrapTransactionalEmail(
        'Reset your password',
        `
            <p style="margin:0 0 16px;">Hi ${escapeHtml(customerName)},</p>
            <p style="margin:0 0 16px;">We received a request to reset your password for your account at <strong>${escapeHtml(websiteURL)}</strong>.</p>
            ${ctaButton({ href: resetLink, label: 'Reset my password' })}
            <p style="margin:0 0 16px;">This link will expire shortly. If you did not request this, please ignore this email.</p>
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
        `,
        { ...wrapBranding(formattedClientName, branding) }
    );

    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decryptedEmail,
            to: clientEmail,
            subject: 'Reset Password',
            ...mimeFrom(emailContent, '', emailSignature),
        },
        5,
        1600,
        qm
    );
    console.log('Reset password email sent successfully');
}

// -----------------------------
// Dashboard team login — password reset (from Khana admin mailbox)
// -----------------------------
async function sendTeamDashboardResetEmail({
  memberEmail,
  memberName,
  companyName,
  clientID,
  resetLink,
  adminBusinessEmail,
  adminBusinessEmailPassword,
  adminCompanyName,
  emailSignature = '',
  adminClientId = null,
}) {
  const formattedClientName = getFormattedClientName(adminCompanyName || 'Khana Technologies');
  const decryptedFrom = decrypt(adminBusinessEmail);
  const qm = qTenant(adminClientId);

  const emailContent = wrapTransactionalEmail(
    'Reset your dashboard password',
    `
            <p style="margin:0 0 16px;">Hi ${escapeHtml(memberName || memberEmail)},</p>
            <p style="margin:0 0 16px;">We received a request to reset the password for your <strong>${escapeHtml(companyName)}</strong> dashboard account.</p>
            ${neutralPanel({
              html: `
                <p style="margin:0 0 8px;"><strong>Client ID:</strong> ${escapeHtml(clientID)}</p>
                <p style="margin:0;"><strong>Login email:</strong> ${escapeHtml(memberEmail)}</p>
              `,
            })}
            ${ctaButton({ href: resetLink, label: 'Reset my password' })}
            <p style="margin:0 0 16px;">This link expires in 1 hour. If you did not request this, please ignore this email.</p>
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
        `,
    { formattedClientName, showKhanaLogo: true }
  );

  const result = await sendWithRetry(
    () => createTransporter(adminBusinessEmail, adminBusinessEmailPassword),
    {
      from: decryptedFrom,
      to: memberEmail,
      subject: `Reset your ${companyName} dashboard password`,
      ...mimeFrom(
        emailContent,
        `Reset your dashboard password for ${companyName} (Client ID: ${clientID}). Link expires in 1 hour: ${resetLink}`,
        emailSignature
      ),
    },
    5,
    1600,
    qm
  );

  console.log(
    `[sendTeamDashboardResetEmail] Sent to ${memberEmail} for client ${clientID}` +
      (result?.messageId ? ` (messageId: ${result.messageId})` : ' (queued for retry)')
  );
  return result;
}

// -----------------------------
// Dashboard team login — invite (from Khana admin mailbox)
// -----------------------------
async function sendTeamDashboardInviteEmail({
  memberEmail,
  memberName,
  companyName,
  clientID,
  inviteLink,
  adminBusinessEmail,
  adminBusinessEmailPassword,
  adminCompanyName,
  emailSignature = '',
  adminClientId = null,
}) {
  const formattedClientName = getFormattedClientName(adminCompanyName || 'Khana Technologies');
  const decryptedFrom = decrypt(adminBusinessEmail);
  const qm = qTenant(adminClientId);

  const emailContent = wrapTransactionalEmail(
    "You're invited to the dashboard",
    `
            <p style="margin:0 0 16px;">Hi ${escapeHtml(memberName || memberEmail)},</p>
            <p style="margin:0 0 16px;"><strong>${escapeHtml(companyName)}</strong> has invited you to access their Khana dashboard.</p>
            ${neutralPanel({
              html: `
                <p style="margin:0 0 8px;"><strong>Client ID:</strong> ${escapeHtml(clientID)}</p>
                <p style="margin:0;"><strong>Your login email:</strong> ${escapeHtml(memberEmail)}</p>
              `,
            })}
            <p style="margin:0 0 16px;">Click below to choose your password and activate your account.</p>
            ${ctaButton({ href: inviteLink, label: 'Accept invite' })}
            <p style="margin:0 0 16px;">This link expires in 7 days. After activating, sign in with Client ID, your email, and the password you choose.</p>
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
        `,
    { formattedClientName, showKhanaLogo: true }
  );

  const result = await sendWithRetry(
    () => createTransporter(adminBusinessEmail, adminBusinessEmailPassword),
    {
      from: decryptedFrom,
      to: memberEmail,
      subject: `You're invited to ${companyName}'s Khana dashboard`,
      ...mimeFrom(
        emailContent,
        `You're invited to ${companyName}'s dashboard (Client ID: ${clientID}). Accept your invite: ${inviteLink}`,
        emailSignature
      ),
    },
    5,
    1600,
    qm
  );

  console.log(
    `[sendTeamDashboardInviteEmail] Sent to ${memberEmail} for client ${clientID}` +
      (result?.messageId ? ` (messageId: ${result.messageId})` : ' (queued for retry)')
  );
  return result;
}

// -----------------------------
// Dashboard activity — owner email alerts
// -----------------------------
async function sendTeamActivityNotifyEmail({
  ownerEmail,
  ownerName,
  companyName,
  clientID,
  categoryLabel,
  summary,
  activityUrl,
  adminBusinessEmail,
  adminBusinessEmailPassword,
  adminCompanyName,
  emailSignature = '',
  adminClientId = null,
}) {
  const formattedClientName = getFormattedClientName(adminCompanyName || 'Khana Technologies');
  const decryptedFrom = decrypt(adminBusinessEmail);
  const qm = qTenant(adminClientId);

  const emailContent = wrapTransactionalEmail(
    'Dashboard activity',
    `
            <p style="margin:0 0 16px;">Hi ${escapeHtml(ownerName || ownerEmail)},</p>
            <p style="margin:0 0 16px;"><strong>${escapeHtml(categoryLabel)}</strong> — ${escapeHtml(summary)}</p>
            <p style="margin:0 0 16px;"><strong>Organization:</strong> ${escapeHtml(companyName)} (Client ID: ${escapeHtml(clientID)})</p>
            ${ctaButton({ href: activityUrl, label: 'View activity log' })}
            <p style="margin:0 0 16px;">You receive this because you enabled email alerts for this category in Activity settings.</p>
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
        `,
    { formattedClientName, showKhanaLogo: true }
  );

  const result = await sendWithRetry(
    () => createTransporter(adminBusinessEmail, adminBusinessEmailPassword),
    {
      from: decryptedFrom,
      to: ownerEmail,
      subject: `[${companyName}] ${categoryLabel}: ${summary}`.slice(0, 120),
      ...mimeFrom(
        emailContent,
        `${categoryLabel}: ${summary}\n\nView log: ${activityUrl}`,
        emailSignature
      ),
    },
    5,
    1600,
    qm
  );

  console.log(
    `[sendTeamActivityNotifyEmail] Sent to ${ownerEmail} for ${clientID}` +
      (result?.messageId ? ` (messageId: ${result.messageId})` : '')
  );
  return result;
}

// -----------------------------
// Contact Us Email
// -----------------------------
async function sendContactUsEmail(contactData, bEmail, BEPass, clientName, emailSignature = '', tenantClientId = null, branding = '') {
    const { name, email, phone, subject, message } = contactData;
    const formattedClientName = getFormattedClientName(clientName);
    const decryptedEmail = decrypt(bEmail);
    const qm = qTenant(tenantClientId);

    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safePhone = escapeHtml(phone || 'Not provided');
    const safeSubject = escapeHtml(subject);
    const safeMessage = escapeHtml(message);

    const businessEmailContent = wrapTransactionalEmail(
        'New contact form submission',
        `
            <p style="margin:0 0 16px;">You have received a new message from your website contact form.</p>
            ${infoPanel({
                title: 'Contact details',
                rows: [
                    ['Name', safeName],
                    ['Email', `<a href="mailto:${safeEmail}" style="color:#2563eb;text-decoration:none;">${safeEmail}</a>`],
                    ['Phone', safePhone],
                    ['Subject', safeSubject],
                ],
            })}
            ${neutralPanel({
                title: 'Message',
                html: `<p style="margin:0;white-space:pre-line;">${safeMessage}</p>`,
            })}
            <p style="margin:0 0 16px;">Please respond to this inquiry as soon as possible.</p>
            <p style="margin:0;">Warm regards,<br>Your Website System</p>
        `,
        {
            formattedClientName,
            footerHtml: 'Automated notification from your website contact form.',
        }
    );

    const autoReplyContent = wrapTransactionalEmail(
        'Thank you for contacting us',
        `
            <p style="margin:0 0 16px;">Hi ${safeName},</p>
            <p style="margin:0 0 16px;">Thank you for reaching out to us. We have received your message and will get back to you as soon as possible.</p>
            ${infoPanel({
                title: 'Your message summary',
                html: `
                    <p style="margin:0 0 8px;"><strong>Subject:</strong> ${safeSubject}</p>
                    <p style="margin:0 0 8px;"><strong>Message:</strong></p>
                    <p style="margin:0;white-space:pre-line;padding:12px;background:#f5f5f5;border-radius:6px;">${safeMessage}</p>
                `,
            })}
            ${warnPanel({
                title: 'Response time',
                html: '<p style="margin:0 0 8px;">We typically respond within 24–48 hours during business days.</p><p style="margin:0;">If your matter is urgent, please call us directly.</p>',
            })}
            <p style="margin:0 0 16px;">We appreciate your interest in our services!</p>
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
        `,
        { ...wrapBranding(formattedClientName, branding) }
    );

    const businessBody = mimeFrom(businessEmailContent, '', emailSignature);
    const autoReplyBody = mimeFrom(autoReplyContent, '', emailSignature);

    // Send notification to business
    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decryptedEmail,
            to: decryptedEmail,
            subject: `Contact Form: ${subject}`,
            ...businessBody,
        },
        5,
        1600,
        qm
    );

    await smtpBetweenMessagesGap();

    // Send auto-reply to the person who contacted
    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decryptedEmail,
            to: email,
            subject: `Thank You for Contacting ${formattedClientName.replace('The ', '').replace(' Team', '')}`,
            ...autoReplyBody,
        },
        5,
        1600,
        qm
    );

    console.log('Contact us emails sent successfully');
}

// -----------------------------
// Plan builder quote emails
// -----------------------------
async function sendPlanQuoteEmails({
  quote,
  shareUrl,
  validUntil,
  prospectEmail,
  khanaEmail,
  khanaPass,
  companyName,
  emailSignature = '',
  tenantClientId = null,
}) {
  const {
    buildPlanQuoteTeamHtml,
    buildPlanQuoteProspectHtml,
    formatDisplayDate,
  } = require('../helpers/planQuoteEmail');

  const formattedClientName = getFormattedClientName(companyName);
  const decryptedFrom = decrypt(khanaEmail);
  const qm = qTenant(tenantClientId);
  const validLabel = formatDisplayDate(validUntil);

  const teamHtml = buildPlanQuoteTeamHtml(quote, shareUrl, validUntil);
  const prospectHtml = buildPlanQuoteProspectHtml(quote, shareUrl, validUntil, formattedClientName);

  const teamBody = mimeFrom(teamHtml, '', emailSignature);
  const prospectBody = mimeFrom(prospectHtml, '', emailSignature);

  await sendWithRetry(
    () => createTransporter(khanaEmail, khanaPass),
    {
      from: decryptedFrom,
      to: decryptedFrom,
      replyTo: prospectEmail,
      subject: `Plan estimate — ${quote.prospectName}${quote.businessName ? ` (${quote.businessName})` : ''}`,
      ...teamBody,
    },
    5,
    1600,
    qm
  );

  await smtpBetweenMessagesGap();

  await sendWithRetry(
    () => createTransporter(khanaEmail, khanaPass),
    {
      from: decryptedFrom,
      to: prospectEmail,
      subject: `Your Khana plan estimate — valid until ${validLabel}`,
      ...prospectBody,
    },
    5,
    1600,
    qm
  );

  console.log(`[sendPlanQuoteEmails] Sent team + prospect emails for ${quote.quoteId}`);
}

async function sendPlanQuoteFollowUpEmail({
  quote,
  templateId,
  shareUrl,
  validUntil,
  khanaEmail,
  khanaPass,
  companyName,
  emailSignature = '',
  tenantClientId = null,
  senderName = '',
}) {
  const { buildPlanQuoteFollowUpHtml } = require('../helpers/planQuoteEmail');
  const { renderTemplateEmail } = require('../helpers/planQuoteResponseTemplates');

  const fromName =
    String(senderName || process.env.PLAN_QUOTE_SENDER_NAME || 'The Khana team').trim() ||
    'The Khana team';
  const rendered = renderTemplateEmail(quote, templateId, shareUrl, validUntil, fromName);
  const firstName = String(quote.prospectName || '').trim().split(/\s+/)[0] || 'there';
  const html = buildPlanQuoteFollowUpHtml({
    subject: rendered.subject,
    bodyHtml: rendered.bodyHtml,
    firstName,
  });

  const decryptedFrom = decrypt(khanaEmail);
  const prospectEmail = String(quote.prospectEmail || '').trim().toLowerCase();
  if (!prospectEmail) {
    throw new Error('Prospect email is required to send a follow-up');
  }

  const qm = qTenant(tenantClientId);
  const body = mimeFrom(html, '', emailSignature);

  await sendWithRetry(
    () => createTransporter(khanaEmail, khanaPass),
    {
      from: `"${companyName || 'Khana Technologies'}" <${decryptedFrom}>`,
      to: prospectEmail,
      replyTo: decryptedFrom,
      subject: rendered.subject,
      ...body,
    },
    5,
    1600,
    qm
  );

  console.log(`[sendPlanQuoteFollowUpEmail] Sent ${templateId} to ${prospectEmail} for ${quote.quoteId}`);
  return rendered;
}

// -----------------------------
// Accommodation check-in / check-out reminders (cron / reminder service)
// -----------------------------
async function sendCheckInReminderEmail(booking, bEmail, BEPass, clientName, emailSignature = '', branding = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const checkInDate = formatBookingDate(booking.accommodation?.checkIn || booking.date);
    const html = wrapTransactionalEmail(
        'Check-in reminder',
        `
            <p style="margin:0 0 16px;">Hi ${escapeHtml(booking.customerName)},</p>
            <p style="margin:0 0 16px;">This is a reminder that your check-in is on <strong>${escapeHtml(checkInDate)}</strong>.</p>
            <p style="margin:0 0 16px;">If you have questions, reply to this email.</p>
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
        `,
        { ...wrapBranding(formattedClientName, branding) }
    );
    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decrypt(bEmail),
            to: booking.customerEmail,
            subject: `Check-in reminder — ${checkInDate}`,
            ...mimeFrom(html, '', emailSignature),
        },
        5,
        1600,
        qBooking(booking)
    );
}

async function sendCheckOutReminderEmail(booking, bEmail, BEPass, clientName, emailSignature = '', branding = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const checkOutDate = formatBookingDate(booking.accommodation?.checkOut || booking.date);
    const html = wrapTransactionalEmail(
        'Check-out reminder',
        `
            <p style="margin:0 0 16px;">Hi ${escapeHtml(booking.customerName)},</p>
            <p style="margin:0 0 16px;">This is a reminder that your check-out is on <strong>${escapeHtml(checkOutDate)}</strong>.</p>
            <p style="margin:0 0 16px;">We hope you enjoy your stay. Reply to this email if you need anything.</p>
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
        `,
        { ...wrapBranding(formattedClientName, branding) }
    );
    await sendWithRetry(
        () => createTransporter(bEmail, BEPass),
        {
            from: decrypt(bEmail),
            to: booking.customerEmail,
            subject: `Check-out reminder — ${checkOutDate}`,
            ...mimeFrom(html, '', emailSignature),
        },
        5,
        1600,
        qBooking(booking)
    );
}

module.exports = {
    sendBookingConfirmationEmail,
    sendBookingReminderEmail,
    sendPaymentConfirmationEmail,
    sendBookingCancellationEmail,
    sendReschedulingEmail,
    sendBookingUpdateNotificationEmail,
    sendBookingEmailReassignedNotice,
    sendBookingStatementEmail,
    sendOrderConfirmationEmail,
    sendOrderStatusUpdateEmail,
    sendAccommodationConfirmationEmail,
    sendMixedBookingConfirmationEmail,
    sendResetPasswordEmail,
    sendTeamDashboardResetEmail,
    sendTeamDashboardInviteEmail,
    sendTeamActivityNotifyEmail,
    sendContactUsEmail,
    sendPlanQuoteEmails,
    sendPlanQuoteFollowUpEmail,
    sendCheckInReminderEmail,
    sendCheckOutReminderEmail,
    diffBookingForCustomer,
    createTransporter,
    deliverQueuedOutboundEmail,
};
