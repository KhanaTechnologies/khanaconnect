const nodemailer = require('nodemailer');
const { decrypt } = require('../helpers/encryption');
const { resolveSmtpHost, resolveSmtpPort, resolveSmtpSecure } = require('../helpers/mailHost');
const { escapeHtml, mergeEmailSignature } = require('../helpers/signatureHtml');
const { inlineSignatureImages } = require('../helpers/mailer');

const failedAttempts = new Map();
const MAX_ATTEMPTS = 1;
const COOLDOWN_MINUTES = 30;

function isLockedOut(email) {
    const info = failedAttempts.get(email);
    if (!info) return false;

    const { count, lastFailed } = info;
    const minutesSinceLastFail = (Date.now() - lastFailed) / 60000;

    return count >= MAX_ATTEMPTS && minutesSinceLastFail < COOLDOWN_MINUTES;
}

function extractDomain(url) {
    if (!url) return '';
    let domain = url
        .replace(/https?:\/\//, '')
        .replace(/^www\./, '')
        .split('/')[0]
        .split('?')[0];
    return domain;
}

async function sendVerificationEmail(userEmail, verificationURL, bEmail, BEPass, websiteURL, clientName, emailSignature = '') {
    const decryptedEmail = decrypt(bEmail);
    const decryptedPass = decrypt(BEPass);

    const formattedClientName = clientName
        ? 'The ' + clientName.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase()).trim() + ' Team'
        : 'The Khana Connect Team';

    if (isLockedOut(decryptedEmail)) {
        console.warn(`Email sending temporarily disabled for ${decryptedEmail} due to repeated failures.`);
        return;
    }

    const domain = extractDomain(websiteURL);
    const host = resolveSmtpHost({ businessEmail: decryptedEmail });
    const port = resolveSmtpPort({ businessEmail: decryptedEmail }, host);
    const secure = resolveSmtpSecure(port);

    if (!host) {
        console.error('[sendVerificationEmail] Could not resolve SMTP host for', decryptedEmail, 'site:', domain);
        throw new Error('SMTP host could not be resolved for this business email.');
    }

    const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        requireTLS: port === 587,
        auth: {
            user: decryptedEmail,
            pass: decryptedPass,
        },
        tls: { rejectUnauthorized: false, minVersion: 'TLSv1.2' },
    });

    const safeUrlDisplay = escapeHtml(verificationURL);
    const brandPlain = formattedClientName.replace('The ', '').replace(' Team', '');

    const emailContent = `
        <div style="font-family: Arial, Helvetica, sans-serif; color: #111827; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #1f2937;">Confirm your email</h2>
            <p>Hi there,</p>
            <p>Thanks for registering with <strong>${escapeHtml(brandPlain)}</strong>. Please confirm this email address belongs to you by using the button below.</p>

            <div style="text-align: center; margin: 28px 0;">
                <a href="${verificationURL}" style="background-color: #2563eb; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">
                    Verify my email
                </a>
            </div>

            <p style="font-size: 14px; color: #4b5563;">If the button does not work, copy and paste this link into your browser:</p>
            <p style="word-break: break-all; font-size: 13px;"><a href="${verificationURL}">${safeUrlDisplay}</a></p>

            <div style="margin: 24px 0; padding: 14px; background: #fef3c7; border-left: 4px solid #f59e0b; font-size: 14px;">
                <strong>Security:</strong> this link expires in about one hour. If you did not create an account, you can ignore this message — no changes will be made.
            </div>

            <p style="margin-top: 28px;">Warm regards,<br>${formattedClientName}</p>
            <hr style="margin-top: 36px; border: none; border-top: 1px solid #e5e7eb;">
            <p style="font-size: 12px; color: #6b7280;">Sent by ${escapeHtml(brandPlain)} for account verification only.</p>
        </div>
    `;

    let merged = { html: emailContent, text: '' };
    if (emailSignature && String(emailSignature).trim()) {
        try {
            merged = mergeEmailSignature(emailContent, '', String(emailSignature));
        } catch {
            merged = { html: emailContent, text: '' };
        }
    }
    const textBody =
        merged.text ||
        (merged.html || '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]*>/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    const { html: htmlOut, attachments } = inlineSignatureImages(merged.html, []);
    const recipientEmail = decrypt(userEmail);

    try {
        await transporter.sendMail({
            from: `"${formattedClientName.replace(/<[^>]+>/g, '')}" <${decryptedEmail}>`,
            to: recipientEmail,
            subject: 'Confirm your email address',
            text: textBody,
            html: htmlOut,
            attachments: attachments || [],
        });

        console.log('Verification email sent successfully');
        failedAttempts.delete(decryptedEmail);
    } catch (error) {
        console.error('Error sending verification email:', error);

        const previous = failedAttempts.get(decryptedEmail) || { count: 0, lastFailed: 0 };
        failedAttempts.set(decryptedEmail, {
            count: previous.count + 1,
            lastFailed: Date.now(),
        });

        throw error;
    }
}

module.exports = { sendVerificationEmail, extractDomain };
