const { sendMailWithRetry } = require('../helpers/mailer');
const { decrypt } = require('../helpers/encryption');
const {
    resolveSmtpHost,
    resolveSmtpPort,
    resolveSmtpSecure,
    resolveBusinessEmail,
} = require('../helpers/mailHost');
const { isSmtpAuthError } = require('../helpers/smtpErrors');
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
const Client = require('../models/client');

const failedAttempts = new Map();
const MAX_ATTEMPTS = 3;
const COOLDOWN_MINUTES = 5;

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

function resolveMailCredentials(bEmail, BEPass, client) {
    if (client) {
        return {
            user: resolveBusinessEmail(client) || decrypt(bEmail),
            pass: client.businessEmailPassword || decrypt(BEPass),
        };
    }
    return {
        user: decrypt(bEmail),
        pass: decrypt(BEPass),
    };
}

async function sendViaKhanaFallback(mailOptions, formattedClientName, clientFromEmail) {
    const khana = await Client.findOne({ clientID: 'Khana' }).select(
        'businessEmail businessEmailPassword smtpHost smtpPort imapHost return_url companyName clientID'
    );
    if (!khana?.businessEmail) return false;

    const khanaHost = resolveSmtpHost(khana);
    const khanaPort = resolveSmtpPort(khana, khanaHost);
    if (!khanaHost) return false;

    const khanaFrom = resolveBusinessEmail(khana);
    await sendMailWithRetry(
        {
            ...mailOptions,
            host: khanaHost,
            port: khanaPort,
            secure: resolveSmtpSecure(khanaPort),
            user: khanaFrom,
            pass: khana.businessEmailPassword,
            from: `"${formattedClientName.replace(/<[^>]+>/g, '')}" <${khanaFrom}>`,
            replyTo: clientFromEmail,
        },
        3
    );
    console.log('[sendVerificationEmail] Sent via Khana platform fallback');
    return true;
}

async function sendVerificationEmail(
    userEmail,
    verificationURL,
    bEmail,
    BEPass,
    websiteURL,
    clientName,
    emailSignature = '',
    branding = '',
    client = null
) {
    const mailClient =
        client ||
        ({
            businessEmail: bEmail,
            businessEmailPassword: BEPass,
            return_url: websiteURL,
            smtpHost: branding?.smtpHost,
            smtpPort: branding?.smtpPort,
            imapHost: branding?.imapHost,
        });

    const { user: smtpUser, pass: smtpPass } = resolveMailCredentials(bEmail, BEPass, client);
    const recipientEmail = decrypt(userEmail);

    const formattedClientName = clientName
        ? 'The ' + clientName.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase()).trim() + ' Team'
        : 'The Khana Connect Team';

    if (isLockedOut(smtpUser)) {
        console.warn(`Email sending temporarily disabled for ${smtpUser} due to repeated failures.`);
        return;
    }

    const domain = extractDomain(websiteURL);
    const smtpHost = resolveSmtpHost(mailClient);
    const smtpPort = resolveSmtpPort(mailClient, smtpHost);
    const secure = resolveSmtpSecure(smtpPort);

    if (!smtpHost) {
        console.error('[sendVerificationEmail] Could not resolve SMTP host for', smtpUser, 'site:', domain);
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

    const mailOptions = {
        host: smtpHost,
        port: smtpPort,
        secure,
        user: smtpUser,
        pass: smtpPass,
        from: `"${formattedClientName.replace(/<[^>]+>/g, '')}" <${smtpUser}>`,
        to: recipientEmail,
        subject: 'Confirm your email address',
        text: textBody,
        html: htmlOut,
        attachments: formatEmailAttachments(attachments || []),
        saveToSent: false,
        clientID: client?.clientID,
    };

    try {
        await sendMailWithRetry(mailOptions, 3);

        console.log('Verification email sent successfully');
        failedAttempts.delete(smtpUser);
    } catch (error) {
        console.error('Error sending verification email:', error);

        if (isSmtpAuthError(error) && client?.clientID !== 'Khana') {
            try {
                const sent = await sendViaKhanaFallback(mailOptions, formattedClientName, smtpUser);
                if (sent) {
                    failedAttempts.delete(smtpUser);
                    return;
                }
            } catch (fallbackError) {
                console.error('[sendVerificationEmail] Khana fallback failed:', fallbackError.message);
            }
        }

        if (!isSmtpAuthError(error)) {
            const previous = failedAttempts.get(smtpUser) || { count: 0, lastFailed: 0 };
            failedAttempts.set(smtpUser, {
                count: previous.count + 1,
                lastFailed: Date.now(),
            });
        }

        throw error;
    }
}

module.exports = { sendVerificationEmail, extractDomain };
