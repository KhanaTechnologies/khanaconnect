// helpers/mailer.js - COMPLETE FIXED VERSION
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const Email = require('../models/Email');

// Create a transporter pool to reuse connections
const transporterPool = new Map();

function getTransporter(config) {
  const key = `${config.host}:${config.port}:${config.user}`;
  
  if (!transporterPool.has(key)) {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465 || config.port === 587,
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
async function saveToSentFolder(clientConfig, emailContent) {
  const { host, port = 993, user, pass } = clientConfig;
  
  let imap;
  try {
    console.log('💾 Saving to IMAP Sent folder...');
    
    // Convert SMTP host to IMAP host if needed
    const imapHost = host.replace(/^smtp\./, 'mail.').replace(/^smtp/, 'imap');
    
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

    // Use HTML content if available, otherwise use text
    const emailBody = emailContent.html || emailContent.text || 'No content';
    
    // Create proper RFC 822 message
    const rfc822Message = `From: ${emailContent.from}
To: ${emailContent.to}
${emailContent.cc ? `Cc: ${emailContent.cc}\n` : ''}
${emailContent.bcc ? `Bcc: ${emailContent.bcc}\n` : ''}
Subject: ${emailContent.subject}
Date: ${new Date().toUTCString()}
Message-ID: ${emailContent.messageId}
${emailContent.inReplyTo ? `In-Reply-To: ${emailContent.inReplyTo}\n` : ''}
${emailContent.references ? `References: ${emailContent.references}\n` : ''}
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="boundary_${Date.now()}"

--boundary_${Date.now()}
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: 7bit

${emailContent.text || emailContent.html?.replace(/<[^>]*>/g, '') || 'No text content'}

--boundary_${Date.now()}
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: 7bit

${emailContent.html || emailContent.text || 'No HTML content'}

--boundary_${Date.now()}--`;

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
    secure = false,
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
    clientID
  } = options;

  // Validate required fields
  if (!host || !user || !pass || !from || !to) {
    throw new Error('Missing required email parameters: host, user, pass, from, to');
  }

  // Extract domain for Message-ID generation
  const domain = extractCleanEmail(from).split('@')[1]?.split('.')[0] || 'localhost';
  
  // Generate Message-ID if not provided
  const finalMessageId = messageId || Email.generateMessageId(domain);

  // Use connection pooling
  const transporter = getTransporter({
    host, 
    port, 
    secure: port === 465,
    user, 
    pass, 
    tls: { rejectUnauthorized: false }
  });

  const mailOptions = {
    from: from,
    to: to,
    subject: subject || '(no subject)',
    text: text || html?.replace(/<[^>]*>/g, '') || 'No content',
    html: html || text || 'No content',
    attachments: attachments.map(att => ({
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
          html: html || '',
          messageId: finalMessageId,
          remoteId: finalMessageId,
          direction: 'outbound',
          flags: ['\\Seen'],
          attachments: attachments.map(att => ({
            filename: att.filename,
            contentType: att.contentType,
            size: att.content?.length || 0,
            contentId: att.cid
          })),
          inReplyTo,
          references: Array.isArray(references) ? references : references?.split(' ') || [],
          threadId,
          isThreadStarter: !inReplyTo && (!references || references.length === 0)
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
        await saveToSentFolder(
          { 
            host,
            port: 993,
            user, 
            pass 
          },
          {
            from,
            to,
            cc,
            bcc,
            subject,
            text: text || html?.replace(/<[^>]*>/g, '') || '',
            html: html || text || '',
            messageId: finalMessageId,
            inReplyTo,
            references: Array.isArray(references) ? references.join(' ') : references
          }
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
    
    // Clean up transporter on error
    const key = `${host}:${port}:${user}`;
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