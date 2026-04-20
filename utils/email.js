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
 * @param {{ clientID: string, label?: string } | null} queueMeta - when SMTP still fails after retries, enqueue for delayed resend (BullMQ)
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

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// -----------------------------
// Booking updated (moved / edited) — customer notification
// -----------------------------
async function sendBookingUpdateNotificationEmail(booking, changeRows, bEmail, BEPass, clientName, options = {}) {
    if (!changeRows || changeRows.length === 0) return;
    const { reason = '', toEmail, emailSignature = '' } = options;
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

    const emailContent = `
        <div style="font-family: Arial, Helvetica, sans-serif; color: #111827; max-width: 640px; margin: auto;">
            <h2 style="text-align: center; color: #1f2937;">Your booking was updated</h2>
            <p>Hi ${escapeHtml(booking.customerName)},</p>
            <p>We adjusted your booking details. Below is a summary of what changed and your <strong>current</strong> booking information.</p>
            ${reason ? `<p><strong>Note from the business:</strong> ${escapeHtml(reason)}</p>` : ''}

            <div style="margin: 20px 0; padding: 16px; background-color: #fffbeb; border-left: 4px solid #f59e0b;">
                <h3 style="margin-top: 0;">Changes</h3>
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

            <div style="margin: 20px 0; padding: 16px; background-color: #eff6ff; border-left: 4px solid #3b82f6;">
                <h3 style="margin-top: 0;">Current booking</h3>
                <p><strong>Date:</strong> ${escapeHtml(formattedDate)}</p>
                <p><strong>Time:</strong> ${escapeHtml(booking.time || '')}${booking.endTime ? ` – ${escapeHtml(booking.endTime)}` : ''}</p>
                <p><strong>Services:</strong></p>
                <ul>${servicesList}</ul>
                <p><strong>Status:</strong> ${escapeHtml(booking.status || '')}</p>
            </div>

            <p style="margin-top: 24px;">If something looks wrong, reply to this email or call us.</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

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
async function sendBookingEmailReassignedNotice(prevEmail, booking, bEmail, BEPass, clientName, emailSignature = '') {
    if (!prevEmail) return;
    const formattedClientName = getFormattedClientName(clientName);
    const html = `
        <div style="font-family: Arial, Helvetica, sans-serif; color: #111827; max-width: 600px; margin: auto;">
            <h2 style="color:#1f2937;">Booking notifications moved</h2>
            <p>This address is no longer the primary contact on a booking for <strong>${escapeHtml(booking.customerName || 'a guest')}</strong>.</p>
            <p>Future updates will be sent to: <strong>${escapeHtml(booking.customerEmail)}</strong>.</p>
            <p>If you did not request this change, please contact ${formattedClientName.replace(/<[^>]+>/g, '')}.</p>
            <p style="margin-top:24px;">${formattedClientName}</p>
        </div>`;
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
async function sendBookingStatementEmail(booking, bEmail, BEPass, clientName, emailSignature = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const formattedDate = formatBookingDate(booking.date);
    const servicesList = (booking.services || []).map((service) => `<li>${escapeHtml(service)}</li>`).join('');
    const pay = booking.payment || {};
    const status = pay.status || 'pending';
    const amount = pay.amount != null ? `R${Number(pay.amount).toFixed(2)}` : '—';
    const deposit = pay.depositAmount != null ? `R${Number(pay.depositAmount).toFixed(2)}` : '';
    const balance = pay.balanceDue != null ? `R${Number(pay.balanceDue).toFixed(2)}` : '';

    const emailContent = `
        <div style="font-family: Arial, Helvetica, sans-serif; color: #111827; max-width: 640px; margin: auto;">
            <h2 style="text-align: center; color: #1f2937;">Booking statement</h2>
            <p>Hi ${escapeHtml(booking.customerName)},</p>
            <p>Here is a summary of your booking and any recorded payment — <strong>for your records only</strong>. This is <strong>not</strong> a bill and <strong>no action is required</strong> unless we have contacted you separately.</p>

            <div style="margin:16px 0;padding:14px;background:#ecfdf5;border-left:4px solid #10b981;">
                <strong>Record only</strong> — not a payment request.
            </div>

            <div style="margin: 20px 0; padding: 16px; background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;">
                <h3 style="margin-top: 0;">Booking</h3>
                <p><strong>Date:</strong> ${escapeHtml(formattedDate)}</p>
                <p><strong>Time:</strong> ${escapeHtml(booking.time || '')}${booking.endTime ? ` – ${escapeHtml(booking.endTime)}` : ''}</p>
                <p><strong>Services:</strong></p>
                <ul>${servicesList}</ul>
                <p><strong>Booking status:</strong> ${escapeHtml(booking.status || '')}</p>
            </div>

            <div style="margin: 20px 0; padding: 16px; background-color: #eff6ff; border-left: 4px solid #3b82f6;">
                <h3 style="margin-top: 0;">Payment on file</h3>
                <p><strong>Payment status:</strong> ${escapeHtml(status)}</p>
                <p><strong>Recorded amount:</strong> ${escapeHtml(amount)}</p>
                ${deposit ? `<p><strong>Deposit recorded:</strong> ${escapeHtml(deposit)}</p>` : ''}
                ${balance ? `<p><strong>Balance noted:</strong> ${escapeHtml(balance)}</p>` : ''}
                ${pay.transactionId ? `<p><strong>Reference / transaction id:</strong> ${escapeHtml(String(pay.transactionId))}</p>` : ''}
                ${pay.paidAt ? `<p><strong>Recorded paid at:</strong> ${escapeHtml(new Date(pay.paidAt).toLocaleString())}</p>` : ''}
            </div>

            <p style="margin-top: 24px;">Questions? Reply to this email.</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

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
async function sendBookingConfirmationEmail(booking, bEmail, BEPass, clientName, emailSignature = '') {
    console.log('Sending booking confirmation with decrypted credentials');
    const formattedClientName = getFormattedClientName(clientName);
    const formattedDate = formatBookingDate(booking.date);

    const servicesList = booking.services.map(service => `<li>${service}</li>`).join('');

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Booking Confirmed! 🎉</h2>
            <p>Hi ${booking.customerName},</p>
            <p>Your booking has been confirmed. We're looking forward to seeing you!</p>

            <div style="margin: 20px 0; padding: 15px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h3 style="margin-top: 0;">Booking Details</h3>
                <p><strong>Date:</strong> ${formattedDate}</p>
                <p><strong>Time:</strong> ${booking.time} - ${booking.endTime}</p>
                <p><strong>Services:</strong></p>
                <ul>${servicesList}</ul>
                ${booking.notes ? `<p><strong>Notes:</strong> ${booking.notes}</p>` : ''}
                ${booking.payment.amount ? `<p><strong>Amount:</strong> R${booking.payment.amount}</p>` : ''}
            </div>

            <div style="margin: 20px 0; padding: 15px; background-color: #fff3cd; border-left: 4px solid #ffc107;">
                <h4 style="margin-top: 0;">📍 Location & Preparation</h4>
                <p>Please arrive 10 minutes before your scheduled time.</p>
                <p>If you need to reschedule or cancel, please contact us at least 24 hours in advance.</p>
            </div>

            <p style="margin-top: 30px;">If you have any questions, feel free to reply to this email.</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

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
async function sendBookingReminderEmail(booking, bEmail, BEPass, clientName, emailSignature = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const formattedDate = formatBookingDate(booking.date);

    const servicesList = booking.services.map(service => `<li>${service}</li>`).join('');

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Friendly Reminder: Booking Tomorrow! ⏰</h2>
            <p>Hi ${booking.customerName},</p>
            <p>This is a friendly reminder about your booking scheduled for tomorrow.</p>

            <div style="margin: 20px 0; padding: 15px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h3 style="margin-top: 0;">Booking Details</h3>
                <p><strong>Date:</strong> ${formattedDate}</p>
                <p><strong>Time:</strong> ${booking.time} - ${booking.endTime}</p>
                <p><strong>Services:</strong></p>
                <ul>${servicesList}</ul>
            </div>

            <div style="margin: 20px 0; padding: 15px; background-color: #d4edda; border-left: 4px solid #28a745;">
                <h4 style="margin-top: 0;">💡 Tips for Your Visit</h4>
                <p>• Please arrive 10 minutes early</p>
                <p>• Bring any necessary documents or items</p>
                <p>• Contact us if you're running late</p>
            </div>

            <p>We're looking forward to seeing you!</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

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
async function sendPaymentConfirmationEmail(booking, bEmail, BEPass, clientName, emailSignature = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const formattedDate = formatBookingDate(booking.date);

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Payment Confirmed! ✅</h2>
            <p>Hi ${booking.customerName},</p>
            <p>Your payment for the upcoming booking has been successfully processed.</p>

            <div style="margin: 20px 0; padding: 15px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h3 style="margin-top: 0;">Payment Details</h3>
                <p><strong>Amount:</strong> R${booking.payment.amount}</p>
                <p><strong>Date:</strong> ${new Date(booking.payment.paidAt).toLocaleDateString()}</p>
                <p><strong>Transaction ID:</strong> ${booking.payment.transactionId}</p>
            </div>

            <div style="margin: 20px 0; padding: 15px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h3 style="margin-top: 0;">Booking Details</h3>
                <p><strong>Date:</strong> ${formattedDate}</p>
                <p><strong>Time:</strong> ${booking.time} - ${booking.endTime}</p>
                <p><strong>Services:</strong> ${booking.services.join(', ')}</p>
            </div>

            <p>Your booking is now confirmed and we're looking forward to seeing you!</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

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
async function sendBookingCancellationEmail(booking, bEmail, BEPass, clientName, reason = '', emailSignature = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const formattedDate = formatBookingDate(booking.date);

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Booking Cancelled</h2>
            <p>Hi ${booking.customerName},</p>
            <p>Your booking has been cancelled.</p>

            <div style="margin: 20px 0; padding: 15px; background-color: #f8d7da; border-left: 4px solid #dc3545;">
                <h3 style="margin-top: 0;">Cancelled Booking Details</h3>
                <p><strong>Date:</strong> ${formattedDate}</p>
                <p><strong>Time:</strong> ${booking.time}</p>
                <p><strong>Services:</strong> ${booking.services.join(', ')}</p>
                ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
            </div>

            ${booking.payment.status === 'paid' ? `
            <div style="margin: 20px 0; padding: 15px; background-color: #fff3cd; border-left: 4px solid #ffc107;">
                <h4 style="margin-top: 0;">Refund Information</h4>
                <p>Your payment will be refunded within 5-7 business days.</p>
            </div>
            ` : ''}

            <p>We hope to see you again in the future!</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

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
async function sendReschedulingEmail(booking, oldDetails, bEmail, BEPass, clientName, reason, emailSignature = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const newFormattedDate = formatBookingDate(booking.date);
    const oldFormattedDate = formatBookingDate(oldDetails.date);

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Booking Rescheduled 🔄</h2>
            <p>Hi ${booking.customerName},</p>
            <p>Your booking has been successfully rescheduled.</p>

            <div style="margin: 20px 0; padding: 15px; background-color: #fff3cd; border-left: 4px solid #ffc107;">
                <h4 style="margin-top: 0;">Previous Booking</h4>
                <p><strong>Date:</strong> ${oldFormattedDate}</p>
                <p><strong>Time:</strong> ${oldDetails.time} - ${oldDetails.endTime}</p>
                ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
            </div>

            <div style="margin: 20px 0; padding: 15px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h3 style="margin-top: 0;">New Booking Details</h3>
                <p><strong>Date:</strong> ${newFormattedDate}</p>
                <p><strong>Time:</strong> ${booking.time} - ${booking.endTime}</p>
                <p><strong>Services:</strong> ${booking.services.join(', ')}</p>
            </div>

            <p>We look forward to seeing you at your new scheduled time!</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

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

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Thank You for Your Order!</h2>
            <p>Hi there,</p>
            <p>We're thrilled you've chosen to shop with us. Here's your order summary:</p>

            <div style="margin: 20px 0; padding: 10px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h4>Order ID</h4>
                <p>${orderID}</p>
            </div>

            <div style="margin: 20px 0; padding: 10px; background-color: #f9f9f9; border-left: 4px solid #4CAF50;">
                <h4>Delivery Address</h4>
                <p><strong>Name:</strong> ${parentOrder.customer.customerFirstName} ${parentOrder.customer.customerLastName}</p>
                <p><strong>Address:</strong> ${parentOrder.address}</p>
                <p><strong>Postal Code:</strong> ${parentOrder.postalCode}</p>
            </div>

            <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
                <thead>
                    <tr style="background-color: #f5f5f5;">
                        <th style="padding: 10px; border: 1px solid #ddd;"></th>
                        <th style="padding: 10px; border: 1px solid #ddd;">Product</th>
                        <th style="padding: 10px; border: 1px solid #ddd;">Qty</th>
                        <th style="padding: 10px; border: 1px solid #ddd;">Price</th>
                        <th style="padding: 10px; border: 1px solid #ddd;">Total</th>
                    </tr>
                </thead>
                <tbody>${orderItemsHtml}</tbody>
            </table>

            <div style="margin-top: 20px;">
                <p><strong>Subtotal:</strong> R${subtotal.toFixed(2)}</p>
                <p><strong>Shipping:</strong> R${shipping.toFixed(2)}</p>
                <p style="font-size: 18px;"><strong>Total Price:</strong> R${total.toFixed(2)}</p>
            </div>

            <p style="margin-top: 30px;">If you have any questions, feel free to reply to this email.</p>
            <p>Warm regards,<br>${formattedClientName}</p>

            <hr style="margin-top: 40px;">
            <p style="font-size: 12px; color: #888;">This email is a confirmation of your recent purchase from ${formattedClientName.replace('The ', '').replace(' Team', '')}.</p>
        </div>
    `;

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

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Order Update: ${status.toUpperCase()}</h2>
            <p>Hi ${customerName},</p>
            <p>${message}</p>
            <div style="margin: 20px 0; padding: 10px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h4>Order ID</h4>
                <p>${orderID}</p>
            </div>
            <p><a href="${viewOrderLink}" style="background-color: #2196F3; color: white; padding: 10px 15px; text-decoration: none; border-radius: 5px;">View My Order</a></p>
            ${status === 'shipped' ? `<p><a href="${trackOrderLink}" style="background-color: #4CAF50; color: white; padding: 10px 15px; text-decoration: none; border-radius: 5px;">Track My Order</a></p>` : ''}
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

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
async function sendAccommodationConfirmationEmail(booking, bEmail, BEPass, clientName, emailSignature = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const decryptedEmail = decrypt(bEmail);
    
    const checkInDate = formatBookingDate(booking.accommodation.checkIn);
    const checkOutDate = formatBookingDate(booking.accommodation.checkOut);

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Accommodation Booking Confirmed! 🏨</h2>
            <p>Hi ${booking.customerName},</p>
            <p>Your accommodation booking has been confirmed. We look forward to hosting you!</p>

            <div style="margin: 20px 0; padding: 15px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h3 style="margin-top: 0;">Accommodation Details</h3>
                <p><strong>Check-in:</strong> ${checkInDate} (from 14:00)</p>
                <p><strong>Check-out:</strong> ${checkOutDate} (until 11:00)</p>
                <p><strong>Duration:</strong> ${booking.accommodation.numberOfNights} night(s)</p>
                <p><strong>Guests:</strong> ${booking.accommodation.numberOfGuests}</p>
                <p><strong>Room Type:</strong> ${booking.accommodation.roomType}</p>
                ${booking.accommodation.specialRequests ? `<p><strong>Special Requests:</strong> ${booking.accommodation.specialRequests}</p>` : ''}
            </div>

            <div style="margin: 20px 0; padding: 15px; background-color: #fff3cd; border-left: 4px solid #ffc107;">
                <h4 style="margin-top: 0;">📍 Location & Arrival</h4>
                <p>Please bring your ID/document for check-in.</p>
                <p>Early check-in and late check-out are subject to availability.</p>
            </div>

            ${booking.payment.amount ? `
            <div style="margin: 20px 0; padding: 15px; background-color: #d4edda; border-left: 4px solid #28a745;">
                <h4 style="margin-top: 0;">💰 Payment Details</h4>
                <p><strong>Total Amount:</strong> R${booking.payment.amount}</p>
                ${booking.payment.depositAmount ? `<p><strong>Deposit Paid:</strong> R${booking.payment.depositAmount}</p>` : ''}
                ${booking.payment.balanceDue ? `<p><strong>Balance Due:</strong> R${booking.payment.balanceDue} (before ${new Date(booking.payment.dueDate).toLocaleDateString()})</p>` : ''}
            </div>
            ` : ''}

            <p style="margin-top: 30px;">If you have any questions about your stay, feel free to reply to this email.</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

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
async function sendMixedBookingConfirmationEmail(booking, bEmail, BEPass, clientName, emailSignature = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const decryptedEmail = decrypt(bEmail);
    
    const serviceDate = formatBookingDate(booking.date);
    const checkInDate = formatBookingDate(booking.accommodation.checkIn);

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Booking Confirmed! 🎉🏨</h2>
            <p>Hi ${booking.customerName},</p>
            <p>Your combined service and accommodation booking has been confirmed!</p>

            <div style="margin: 20px 0; padding: 15px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h3 style="margin-top: 0;">Service Details</h3>
                <p><strong>Date:</strong> ${serviceDate}</p>
                <p><strong>Time:</strong> ${booking.time} - ${booking.endTime}</p>
                <p><strong>Services:</strong> ${booking.services.join(', ')}</p>
            </div>

            <div style="margin: 20px 0; padding: 15px; background-color: #e8f5e8; border-left: 4px solid #4CAF50;">
                <h3 style="margin-top: 0;">Accommodation Details</h3>
                <p><strong>Check-in:</strong> ${checkInDate}</p>
                <p><strong>Duration:</strong> ${booking.accommodation.numberOfNights} night(s)</p>
                <p><strong>Room Type:</strong> ${booking.accommodation.roomType}</p>
            </div>

            <p style="margin-top: 30px;">We look forward to serving you and providing a comfortable stay!</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

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
    tenantClientId = null
) {
    const formattedClientName = getFormattedClientName(clientName);
    const decryptedEmail = decrypt(bEmail);
    const qm = qTenant(tenantClientId);

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Reset Your Password</h2>
            <p>Hi ${customerName},</p>
            <p>We received a request to reset your password for your account at <strong>${websiteURL}</strong>.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetLink}" style="background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px;">
                Reset My Password
              </a>
            </div>
            <p>This link will expire shortly. If you did not request this, please ignore this email.</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

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
// Contact Us Email
// -----------------------------
async function sendContactUsEmail(contactData, bEmail, BEPass, clientName, emailSignature = '', tenantClientId = null) {
    const { name, email, phone, subject, message } = contactData;
    const formattedClientName = getFormattedClientName(clientName);
    const decryptedEmail = decrypt(bEmail);
    const qm = qTenant(tenantClientId);

    // Email to the business/website owner
    const businessEmailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">New Contact Form Submission</h2>
            <p>You have received a new message from your website contact form.</p>

            <div style="margin: 20px 0; padding: 15px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h3 style="margin-top: 0;">Contact Details</h3>
                <p><strong>Name:</strong> ${name}</p>
                <p><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>
                <p><strong>Phone:</strong> ${phone || 'Not provided'}</p>
                <p><strong>Subject:</strong> ${subject}</p>
            </div>

            <div style="margin: 20px 0; padding: 15px; background-color: #f9f9f9; border-left: 4px solid #4CAF50;">
                <h3 style="margin-top: 0;">Message</h3>
                <p style="white-space: pre-line;">${message}</p>
            </div>

            <p style="margin-top: 30px;">Please respond to this inquiry as soon as possible.</p>
            <p>Warm regards,<br>Your Website System</p>
            
            <hr style="margin-top: 40px;">
            <p style="font-size: 12px; color: #888;">This is an automated notification from your website contact form.</p>
        </div>
    `;

    // Auto-reply email to the person who submitted the form
    const autoReplyContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Thank You for Contacting Us</h2>
            <p>Hi ${name},</p>
            <p>Thank you for reaching out to us. We have received your message and will get back to you as soon as possible.</p>

            <div style="margin: 20px 0; padding: 15px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h3 style="margin-top: 0;">Your Message Summary</h3>
                <p><strong>Subject:</strong> ${subject}</p>
                <p><strong>Message:</strong></p>
                <p style="white-space: pre-line; background-color: #f5f5f5; padding: 10px; border-radius: 5px;">${message}</p>
            </div>

            <div style="margin: 20px 0; padding: 15px; background-color: #fff3cd; border-left: 4px solid #ffc107;">
                <h4 style="margin-top: 0;">⏰ Response Time</h4>
                <p>We typically respond within 24-48 hours during business days.</p>
                <p>If your matter is urgent, please call us directly.</p>
            </div>

            <p>We appreciate your interest in our services!</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

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
// Accommodation check-in / check-out reminders (cron / reminder service)
// -----------------------------
async function sendCheckInReminderEmail(booking, bEmail, BEPass, clientName, emailSignature = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const checkInDate = formatBookingDate(booking.accommodation?.checkIn || booking.date);
    const html = `
        <div style="font-family: Arial, Helvetica, sans-serif; color: #111827; max-width: 600px; margin: auto;">
            <h2 style="color: #1f2937;">Check-in reminder</h2>
            <p>Hi ${escapeHtml(booking.customerName)},</p>
            <p>This is a reminder that your check-in is on <strong>${escapeHtml(checkInDate)}</strong>.</p>
            <p>If you have questions, reply to this email.</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>`;
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

async function sendCheckOutReminderEmail(booking, bEmail, BEPass, clientName, emailSignature = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const checkOutDate = formatBookingDate(booking.accommodation?.checkOut || booking.date);
    const html = `
        <div style="font-family: Arial, Helvetica, sans-serif; color: #111827; max-width: 600px; margin: auto;">
            <h2 style="color: #1f2937;">Check-out reminder</h2>
            <p>Hi ${escapeHtml(booking.customerName)},</p>
            <p>This is a reminder that your check-out is on <strong>${escapeHtml(checkOutDate)}</strong>.</p>
            <p>We hope you enjoy your stay. Reply to this email if you need anything.</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>`;
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
    sendContactUsEmail,
    sendCheckInReminderEmail,
    sendCheckOutReminderEmail,
    diffBookingForCustomer,
    createTransporter,
    deliverQueuedOutboundEmail,
};
