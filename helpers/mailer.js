// helpers/mailer.js - COMPLETE FIXED VERSION
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { ImapFlow } = require('imapflow');
const Email = require('../models/Email');
const { smtpHostToImapForSent } = require('./mailHost');

/** Uploaded dashboard signatures are stored here and referenced by absolute URL in Client.emailSignature */
const SIGNATURES_UPLOAD_DIR = path.join(__dirname, '../public/uploads/signatures');

function contentTypeForSignatureFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml';
  return 'image/jpeg';
}

/**
 * Resolve dashboard signature image on disk from an <img src> (absolute URL or site-relative path).
 * Returns null if not a known signature path or file missing.
 */
function resolveLocalSignatureFileFromImgSrc(src) {
  if (!src || typeof src !== 'string') return null;
  const trimmed = src.trim();
  if (trimmed.startsWith('cid:')) return null;

  const marker = '/public/uploads/signatures/';
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const u = new URL(trimmed);
      const idx = u.pathname.indexOf(marker);
      if (idx === -1) return null;
      const rel = u.pathname.slice(idx + marker.length);
      const base = path.basename(rel);
      if (!base || base.includes('..')) return null;
      const full = path.join(SIGNATURES_UPLOAD_DIR, base);
      return fs.existsSync(full) ? full : null;
    }
    if (trimmed.startsWith(marker)) {
      const base = path.basename(trimmed.slice(marker.length));
      if (!base || base.includes('..')) return null;
      const full = path.join(SIGNATURES_UPLOAD_DIR, base);
      return fs.existsSync(full) ? full : null;
    }
  } catch (_) {
    return null;
  }
  return null;
}

/**
 * Gmail and many clients do not load remote images from localhost or private hosts.
 * Inline signature images that live on this server as MIME attachments (cid:) so they always render.
 */
function inlineSignatureImages(html, baseAttachments) {
  const attachments = Array.isArray(baseAttachments) ? [...baseAttachments] : [];
  if (!html || typeof html !== 'string') return { html, attachments };

  const srcToCid = new Map();
  let cidSeq = 0;

  const newHtml = html.replace(
    /<img\b([^>]*?)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>/gi,
    (full, pre, q, srcRaw, post) => {
      const src = String(srcRaw || '').trim();
      const filePath = resolveLocalSignatureFileFromImgSrc(src);
      if (!filePath) return full;

      let cid = srcToCid.get(src);
      if (!cid) {
        cid = `kcsig${cidSeq++}`;
        srcToCid.set(src, cid);
        try {
          attachments.push({
            filename: path.basename(filePath),
            content: fs.readFileSync(filePath),
            contentType: contentTypeForSignatureFile(filePath),
            cid,
          });
        } catch (e) {
          console.warn('Signature inline skipped:', e.message);
          return full;
        }
      }
      return `<img${pre}src=${q}cid:${cid}${q}${post}>`;
    }
  );

  return { html: newHtml, attachments };
}

// Create a transporter pool to reuse connections
const transporterPool = new Map();

function getTransporter(config) {
  const secure =
    typeof config.secure === 'boolean'
      ? config.secure
      : Number(config.port) === 465;
  const requireTLS =
    typeof config.requireTLS === 'boolean'
      ? config.requireTLS
      : Number(config.port) === 587;
  const key = `${config.host}:${config.port}:${config.user}:${secure ? '1' : '0'}:${requireTLS ? 't' : 'f'}`;

  if (!transporterPool.has(key)) {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure,
      requireTLS,
      auth: { 
        user: config.user, 
        pass: config.pass 
      },
      tls: {
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2'
      },
      pool: true,
      maxConnections: 1,
      maxMessages: 10,
      connectionTimeout: 30000,
      greetingTimeout: 30000
    });
    
    transporterPool.set(key, transporter);
  }
  
  return transporterPool.get(key);
}

/**
 * Helper function to extract clean email
 */
function extractCleanEmail(emailString) {
  if (!emailString || typeof emailString !== 'string') return '';
  
  const trimmed = emailString.trim();
  if (trimmed === '') return '';
  
  const emailMatch = trimmed.match(/<([^>]+)>/);
  if (emailMatch && emailMatch[1]) {
    return emailMatch[1].trim().toLowerCase();
  }
  
  return trimmed.replace(/"/g, '').toLowerCase();
}

/**
 * Save sent email to IMAP Sent folder
 */
function buildRawMime(mailLike) {
  const composer = new MailComposer(mailLike);
  return new Promise((resolve, reject) => {
    composer.compile().build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}

async function saveToSentFolder(clientConfig, mailLike) {
  const { host, port = 993, user, pass } = clientConfig;
  
  let imap;
  try {
    console.log('💾 Saving to IMAP Sent folder...');
    
    const imapHost = smtpHostToImapForSent(host);
    
    imap = new ImapFlow({
      host: imapHost,
      port,
      secure: true,
      auth: { user, pass },
      logger: false,
      tls: { rejectUnauthorized: false }
    });

    await imap.connect();
    
    // Try different common sent folder names
    const sentFolderNames = ['Sent', 'Sent Items', 'Sent Messages'];
    let sentFolder = null;
    
    for (const folderName of sentFolderNames) {
      try {
        await imap.mailboxOpen(folderName);
        sentFolder = folderName;
        console.log(`✅ Found sent folder: ${folderName}`);
        break;
      } catch (e) {
        // Try next folder name
      }
    }
    
    if (!sentFolder) {
      console.log('⚠️ No sent folder found, using INBOX');
      sentFolder = 'INBOX';
    }

    const rfc822Message = await buildRawMime(mailLike);

    // Append to sent folder
    await imap.append(sentFolder, rfc822Message, ['\\Seen'], new Date());
    console.log('✅ Email saved to IMAP Sent folder');

  } catch (error) {
    console.error('❌ Failed to save to IMAP Sent folder:', error.message);
    // Don't throw - just log the error
  } finally {
    if (imap) {
      try {
        await imap.logout();
      } catch (e) {}
    }
  }
}

/**
 * Enhanced sendMail with IMAP Sent folder support
 */
async function sendMail(options) {
  const {
    host,
    port = 587,
    user,
    pass,
    from,
    to,
    subject,
    text,
    html,
    attachments = [],
    inReplyTo = null,
    references = [],
    cc = '',
    bcc = '',
    messageId = null,
    saveToSent = true,
    clientID,
    isNewsletter = false,
    newsletterId = null,
    newsletterRecipient = ''
  } = options;

  // Validate required fields
  if (!host || !user || !pass || !from || !to) {
    throw new Error('Missing required email parameters: host, user, pass, from, to');
  }

  // Extract domain for Message-ID generation
  const domain = extractCleanEmail(from).split('@')[1]?.split('.')[0] || 'localhost';
  
  // Generate Message-ID if not provided
  const finalMessageId = messageId || Email.generateMessageId(domain);

  const secureOpt = Object.prototype.hasOwnProperty.call(options, 'secure')
    ? options.secure
    : undefined;
  const implicitTls =
    typeof secureOpt === 'boolean' ? secureOpt : Number(port) === 465;

  // Use connection pooling
  const transporter = getTransporter({
    host,
    port,
    secure: implicitTls,
    requireTLS: Number(port) === 587,
    user,
    pass,
    tls: { rejectUnauthorized: false },
  });

  const { html: htmlOut, attachments: attachmentsOut } = inlineSignatureImages(html, attachments);

  const mailOptions = {
    from: from,
    to: to,
    subject: subject || '(no subject)',
    text: text || htmlOut?.replace(/<[^>]*>/g, '') || 'No content',
    html: htmlOut || text || 'No content',
    attachments: attachmentsOut.map(att => ({
      filename: att.filename,
      content: att.content,
      contentType: att.contentType,
      cid: att.cid
    })),
    messageId: finalMessageId,
    headers: {
      'X-Mailer': 'HerBeauty CRM'
    }
  };

  // Add CC and BCC if provided
  if (cc) mailOptions.cc = cc;
  if (bcc) mailOptions.bcc = bcc;

  // Add threading headers if provided
  if (inReplyTo) {
    mailOptions.inReplyTo = inReplyTo;
    mailOptions.headers['In-Reply-To'] = inReplyTo;
  }

  if (references && references.length > 0) {
    const refString = Array.isArray(references) ? references.join(' ') : references;
    mailOptions.references = refString;
    mailOptions.headers['References'] = refString;
  }

  console.log('📧 Sending email:', {
    from,
    to,
    subject,
    messageId: finalMessageId,
    inReplyTo,
    references: references?.length || 0
  });

  try {
    // Send the email via SMTP
    const info = await transporter.sendMail(mailOptions);
    
    console.log('✅ Email sent via SMTP:', info.messageId);

    // Also save to database
    if (clientID) {
      try {
        // Compute thread ID
        let threadId;
        if (inReplyTo || references?.length > 0) {
          threadId = await Email.computeThreadId({
            messageId: finalMessageId,
            inReplyTo,
            references: Array.isArray(references) ? references : references?.split(' ') || [],
            clientID
          });
        } else {
          threadId = finalMessageId;
        }

        const emailDoc = new Email({
          clientID,
          from,
          to,
          cc: cc || undefined,
          bcc: bcc || undefined,
          subject,
          text: text || '',
          html: htmlOut || '',
          messageId: finalMessageId,
          remoteId: finalMessageId,
          direction: 'outbound',
          flags: ['\\Seen'],
          attachments: attachmentsOut.map(att => ({
            filename: att.filename,
            contentType: att.contentType,
            size: att.content?.length || 0,
            contentId: att.cid
          })),
          inReplyTo,
          references: Array.isArray(references) ? references : references?.split(' ') || [],
          threadId,
          isThreadStarter: !inReplyTo && (!references || references.length === 0),
          isNewsletter: !!isNewsletter,
          newsletterId: newsletterId || undefined,
          recipientName: newsletterRecipient || ''
        });

        await emailDoc.save();
        console.log('✅ Email saved to database with threadId:', threadId);
        
        // Update thread metadata
        if (threadId) {
          await Email.updateThreadMetadata(clientID, threadId);
        }
      } catch (dbError) {
        console.error('⚠️ Could not save to database:', dbError.message);
      }
    }

    // Save to IMAP Sent folder if requested
    if (saveToSent) {
      try {
        const sentMime = {
          from,
          to,
          cc: cc || undefined,
          bcc: bcc || undefined,
          subject: subject || '(no subject)',
          text: text || htmlOut?.replace(/<[^>]*>/g, '') || '',
          html: htmlOut || text || '',
          messageId: finalMessageId,
          inReplyTo: inReplyTo || undefined,
          references: references && references.length
            ? (Array.isArray(references) ? references.join(' ') : references)
            : undefined,
          attachments: attachmentsOut.map(att => ({
            filename: att.filename,
            content: att.content,
            contentType: att.contentType,
            cid: att.cid
          })),
          headers: { ...mailOptions.headers }
        };
        await saveToSentFolder(
          { host, port: 993, user, pass },
          sentMime
        );
      } catch (sentError) {
        console.error('⚠️ Could not save to sent folder:', sentError.message);
      }
    }

    return {
      messageId: finalMessageId,
      info,
      success: true
    };
    
  } catch (error) {
    console.error('❌ SMTP failed:', error.message);
    
    // Clean up transporter on error (key must match getTransporter)
    const key = `${host}:${port}:${user}:${implicitTls ? '1' : '0'}:${Number(port) === 587 ? 't' : 'f'}`;
    if (transporterPool.has(key)) {
      try {
        await transporterPool.get(key).close();
        transporterPool.delete(key);
      } catch (closeError) {
        console.error('Error closing transporter:', closeError);
      }
    }
    
    throw error;
  }
}

/**
 * Send email with retry logic
 */
async function sendMailWithRetry(options, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 SMTP attempt ${attempt}/${maxRetries}`);
      const result = await sendMail(options);
      return result;
    } catch (error) {
      const isConnectionError = 
        error.message.includes('Too many concurrent') ||
        error.message.includes('421') ||
        error.message.includes('connection') ||
        error.message.includes('ECONNREFUSED') ||
        error.code === 'ECONNECTION';
      
      if (isConnectionError && attempt < maxRetries) {
        // Wait before retrying (exponential backoff)
        const waitTime = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(`⏳ Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      console.error(`❌ SMTP failed on attempt ${attempt}:`, error.message);
      throw error;
    }
  }
}

module.exports = { 
  sendMail, 
  saveToSentFolder, 
  sendMailWithRetry 
};