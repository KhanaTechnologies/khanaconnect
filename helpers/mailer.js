// helpers/mailer.js
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
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
      tls: config.tls,
      // Connection pooling to prevent "too many connections"
      pool: true,
      maxConnections: 1, // Only 1 connection at a time
      maxMessages: 10, // Send up to 10 messages per connection
      connectionTimeout: 30000,
      greetingTimeout: 30000
    });
    
    transporterPool.set(key, transporter);
  }
  
  return transporterPool.get(key);
}

/**
 * Save sent email to IMAP Sent folder
 */
async function saveToSentFolder(clientConfig, emailContent) {
  const { host, port = 993, user, pass, secure = true } = clientConfig;
  
  let imap;
  try {
    console.log('💾 Saving to IMAP Sent folder...');
    console.log('📧 Email content:', {
      from: emailContent.from,
      to: emailContent.to,
      subject: emailContent.subject,
      hasText: !!emailContent.text,
      hasHtml: !!emailContent.html
    });
    
    imap = new ImapFlow({
      host,
      port,
      secure,
      auth: { user, pass },
      logger: false,
      tls: { rejectUnauthorized: false }
    });

    await imap.connect();
    
    // Try different common sent folder names
    const sentFolderNames = ['Sent', 'Sent Items', 'Sent Messages', 'INBOX.Sent'];
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
    
    // Create proper RFC 822 message with both text and HTML
    const rfc822Message = `From: ${emailContent.from}
To: ${emailContent.to}
Subject: ${emailContent.subject}
Date: ${new Date().toUTCString()}
Message-ID: ${emailContent.messageId}
${emailContent.inReplyTo ? `In-Reply-To: ${emailContent.inReplyTo}\n` : ''}
${emailContent.references ? `References: ${emailContent.references}\n` : ''}
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="boundary123"

--boundary123
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: 7bit

${emailContent.text || emailContent.html?.replace(/<[^>]*>/g, '') || 'No text content'}

--boundary123
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: 7bit

${emailContent.html || emailContent.text || 'No HTML content'}

--boundary123--`;

    // Append to sent folder
    await imap.append(sentFolder, rfc822Message, ['\\Seen'], new Date());
    console.log('✅ Email saved to IMAP Sent folder');

  } catch (error) {
    console.error('❌ Failed to save to IMAP Sent folder:', error.message);
    throw error;
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
    port,
    secure,
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
    messageId = null,
    tls = {},
    saveToSent = true
  } = options;

  // Extract domain for Message-ID generation
  const domain = from.split('@')[1]?.replace('>', '') || 'localhost';
  
  // Generate Message-ID if not provided
  const finalMessageId = messageId || Email.generateMessageId(domain);

  // Use connection pooling
  const transporter = getTransporter({
    host, port, secure, user, pass, tls
  });

  const mailOptions = {
    from,
    to,
    subject,
    text: text || html?.replace(/<[^>]*>/g, '') || 'No content', // Fallback
    html: html || text || 'No content', // Fallback
    attachments,
    messageId: finalMessageId,
    headers: {}
  };

  // Add threading headers if provided
  if (inReplyTo) {
    mailOptions.inReplyTo = inReplyTo;
    mailOptions.headers['In-Reply-To'] = inReplyTo;
  }

  if (references && references.length > 0) {
    mailOptions.references = references.join(' ');
    mailOptions.headers['References'] = references.join(' ');
  }

  console.log('📧 Sending email with threading:', {
    messageId: finalMessageId,
    inReplyTo,
    references: references?.length || 0,
    saveToSent,
    hasText: !!text,
    hasHtml: !!html
  });

  let info;
  try {
    // Send the email via SMTP with connection pooling
    info = await transporter.sendMail(mailOptions);
    
    // Ensure we have the messageId
    if (!info.messageId) {
      info.messageId = finalMessageId;
    }

    console.log('✅ Email sent via SMTP successfully');

    // Save to IMAP Sent folder if requested
    if (saveToSent) {
      try {
        await saveToSentFolder(
          { 
            host, 
            port: 993, // Use IMAP port for Sent folder
            user, 
            pass, 
            secure: true // Use SSL for IMAP
          },
          {
            from,
            to,
            subject,
            text: text || html?.replace(/<[^>]*>/g, '') || '',
            html: html || text || '',
            messageId: finalMessageId,
            inReplyTo,
            references: references?.join(' ')
          }
        );
      } catch (sentError) {
        console.error('⚠️ Could not save to sent folder, but email was sent:', sentError.message);
        // Don't throw here - the email was successfully sent via SMTP
      }
    }

    return info;
    
  } catch (error) {
    console.error('❌ SMTP failed:', error.message);
    
    // Close the transporter on error to clean up
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

// Add this to mailer.js - SMTP retry function
async function sendMailWithRetry(options, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`🔄 SMTP attempt ${attempt}/${maxRetries}`);
            const result = await sendMail(options);
            return result;
        } catch (error) {
            if ((error.message.includes('Too many concurrent SMTP connections') || 
                 error.message.includes('421') ||
                 error.message.includes('concurrent')) && 
                attempt < maxRetries) {
                // Wait before retrying (exponential backoff)
                const waitTime = Math.min(1000 * Math.pow(2, attempt), 10000);
                console.log(`⏳ SMTP connection limit hit, waiting ${waitTime}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }
            console.error(`❌ SMTP failed on attempt ${attempt}:`, error.message);
            throw error;
        }
    }
}

// Update exports
module.exports = { sendMail, saveToSentFolder, sendMailWithRetry };