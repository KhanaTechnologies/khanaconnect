const { sendMailWithRetry } = require('../helpers/mailer');
const { decrypt } = require('../helpers/encryption');
const { resolveSmtpHost, resolveSmtpPort, resolveSmtpSecure } = require('../helpers/mailHost');
const { escapeHtml, mergeEmailSignature } = require('../helpers/signatureHtml');
const { inlineSignatureImages } = require('../helpers/mailer');
const { inlineEmailBannerLogosAsync } = require('../helpers/inlineEmailBannerLogo');
const {
    buildKhanaEmail,
    ctaButton,
    warnPanel,
} = require('../helpers/transactionalEmailLayout');
const { normalizeEmailBranding } = require('../helpers/clientEmailBranding');
const { formatEmailAttachments } = require('../helpers/formatEmailAttachments');
const { resolveEmailBrand } = require('../helpers/emailDesignTokens');

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

async function sendVerificationEmail(userEmail, verificationURL, bEmail, BEPass, websiteURL, clientName, emailSignature = '', branding = '') {
    const decryptedEmail = decrypt(bEmail);
    const decryptedPass = decrypt(BEPass);
    const recipientEmail = decrypt(userEmail);

    const formattedClientName = clientName
        ? 'The ' + clientName.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase()).trim() + ' Team'
        : 'The Khana Connect Team';

    if (isLockedOut(decryptedEmail)) {
        console.warn(`Email sending temporarily disabled for ${decryptedEmail} due to repeated failures.`);
        return;
    }

    const domain = extractDomain(websiteURL);
    const smtpHost = resolveSmtpHost({ businessEmail: decryptedEmail, smtpHost: branding?.smtpHost });
    const smtpPort = resolveSmtpPort({ businessEmail: decryptedEmail, smtpPort: branding?.smtpPort }, smtpHost);
    const secure = resolveSmtpSecure(smtpPort);

    if (!smtpHost) {
        console.error('[sendVerificationEmail] Could not resolve SMTP host for', decryptedEmail, 'site:', domain);
        throw new Error('SMTP host could not be resolved for this business email.');
    }

    const safeUrlDisplay = escapeHtml(verificationURL);
    const brandPlain = formattedClientName.replace('The ', '').replace(' Team', '');

    const bodyHtml = `
            <p style="margin:0 0 16px;">Hi there,</p>
            <p style="margin:0 0 16px;">Thanks for registering with <strong>${escapeHtml(brandPlain)}</strong>. Please confirm this email address belongs to you.</p>
            ${ctaButton({ href: verificationURL, label: 'Verify my email' })}
            <p style="margin:0 0 8px;font-size:14px;color:#4b5563;">If the button does not work, copy and paste this link into your browser:</p>
            <p style="margin:0 0 20px;word-break:break-all;font-size:13px;"><a href="${verificationURL}" style="color:#2563eb;">${safeUrlDisplay}</a></p>
            ${warnPanel({
                html: '<strong>Security:</strong> this link expires in about one hour. If you did not create an account, you can ignore this message.',
            })}
            <p style="margin:0;">Warm regards,<br>${formattedClientName}</p>
    `;

    const normalized = normalizeEmailBranding(branding);
    const brand = resolveEmailBrand(normalized);

    const emailContent = buildKhanaEmail({
        headline: 'Confirm your email',
        title: 'Confirm your email address',
        preheader: `Verify your ${brandPlain} account.`,
        bodyHtml,
        brandName: brandPlain,
        logoUrl: brand.logoUrl || undefined,
        showKhanaLogo: false,
        footerHtml: `Sent by ${escapeHtml(brandPlain)} for account verification only.`,
        primaryColor: brand.primaryColor,
    });

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
        `Hi there,

Thanks for registering with ${brandPlain}. Please confirm this email address belongs to you.

Verify your email: ${verificationURL}

This link expires in about one hour. If you did not create an account, you can ignore this message.

— ${formattedClientName.replace(/<[^>]+>/g, '')}`;

    const { html: withSigs, attachments: sigAtt } = inlineSignatureImages(merged.html, []);
    const { html: htmlOut, attachments } = await inlineEmailBannerLogosAsync(withSigs, sigAtt, {});

    try {
        await sendMailWithRetry(
            {
                host: smtpHost,
                port: smtpPort,
                secure,
                user: decryptedEmail,
                pass: decryptedPass,
                from: `"${formattedClientName.replace(/<[^>]+>/g, '')}" <${decryptedEmail}>`,
                to: recipientEmail,
                subject: 'Confirm your email address',
                text: textBody,
                html: htmlOut,
                attachments: formatEmailAttachments(attachments || []),
                saveToSent: false,
            },
            3
        );

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
