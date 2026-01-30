// helpers/imapService.js
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const Email = require('../models/Email');

/**
 * Normalize message ID format
 */
// Update the normalizeMessageId function
function normalizeMessageId(messageId) {
  if (!messageId) return null;
  
  // Remove surrounding whitespace and normalize
  let cleanId = messageId.trim();
  
  // Remove surrounding < > if they exist
  if (cleanId.startsWith('<') && cleanId.endsWith('>')) {
    cleanId = cleanId.substring(1, cleanId.length - 1);
  }
  
  // Ensure it has proper format
  if (!cleanId.includes('@')) {
    console.warn('Message ID missing @ symbol:', cleanId);
    return null;
  }
  
  return `<${cleanId}>`;
}

/**
 * Enhanced thread metadata updater
 */
async function updateThreadMetadata(clientID, threadId) {
  await Email.updateThreadMetadata(clientID, threadId);
}

/**
 * Fetch emails from IMAP with full threading support
 */
async function fetchClientEmails(client) {
  console.log('🚀 IMAP Fetch with Full Threading Support');
  
  if (!client.businessEmail || !client.businessEmailPassword) {
    throw new Error('Client email or password not set');
  }

  let imap;
  try {
    // Extract domain from return_url
    let domain = 'example.com';
    if (client.return_url) {
      try {
        domain = client.return_url.replace(/^https?:\/\//, '').split('/')[0];
      } catch (e) {
        console.warn('Failed to parse domain from return_url:', client.return_url);
      }
    }

    const host = client.imapHost || `mail.${domain}`;
    const port = client.imapPort || 993;
    
    console.log(`🔌 IMAP Connection: ${host}:${port} as ${client.businessEmail}`);

    imap = new ImapFlow({
      host: host,
      port: port,
      secure: true,
      auth: { 
        user: client.businessEmail, 
        pass: client.businessEmailPassword 
      },
      tls: {
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2'
      },
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      logger: {
        debug: console.log,
        info: console.log,
        warn: console.warn,
        error: console.error
      },
      disableAutoIdle: true,
      disableCompression: true
    });

    await imap.connect();
    console.log('✅ Connected to IMAP server');

    await imap.mailboxOpen('INBOX');
    const totalMessages = imap.mailbox.exists || 0;
    console.log(`📊 INBOX contains ${totalMessages} messages`);

    if (totalMessages === 0) {
      console.log('📭 No messages found in INBOX');
      return [];
    }

    // Fetch ALL messages (not just recent ones)
    console.log(`🔄 Fetching ${totalMessages} messages from INBOX`);

    const emails = [];
    const lock = await imap.getMailboxLock('INBOX');
    
    try {
      let processedCount = 0;
      let newEmailsCount = 0;
      
      // Fetch all messages (1 to totalMessages)
      for await (let msg of imap.fetch(`1:${totalMessages}`, { 
        source: true, 
        flags: true, 
        uid: true 
      })) {
        try {
          const parsed = await simpleParser(msg.source);
          
          // Extract and normalize threading headers
          const remoteId = normalizeMessageId(parsed.messageId);
          const inReplyTo = normalizeMessageId(parsed.inReplyTo);
          const references = Email.parseReferences(parsed.references).map(normalizeMessageId);
          
          // Compute threadId using enhanced logic
          const threadId = await Email.computeThreadId({
            messageId: remoteId,
            inReplyTo,
            references,
            clientID: client.clientID
          });

          const emailData = {
              uid: msg.uid,
              remoteId: remoteId,
              messageId: remoteId, // Also store in messageId field
              from: parsed.from?.text || '',
              to: parsed.to?.text || '',
              cc: parsed.cc?.text || '',
              bcc: parsed.bcc?.text || '',
              subject: parsed.subject || '(no subject)',
              text: parsed.text || '',
              html: parsed.html || '',
              date: parsed.date || new Date(),
              flags: Array.isArray(msg.flags) ? msg.flags : [],
              attachments: (parsed.attachments || []).map(a => ({
                filename: a.filename || 'unnamed',
                contentType: a.contentType,
                size: a.size,
                contentId: a.contentId
              })),
              direction: 'inbound',
              clientID: client.clientID,
              inReplyTo,
              references,
              threadId,
              headers: {
                'message-id': remoteId,
                'in-reply-to': inReplyTo,
                'references': parsed.references,
                'subject': parsed.subject,
                'date': parsed.date,
                'from': parsed.from?.text,
                'to': parsed.to?.text
              }
            };

          // Defensive uid cleaning - remove if null/undefined
          if (emailData.uid === null || emailData.uid === 'null' || typeof emailData.uid === 'undefined') {
            delete emailData.uid;
          }

          console.log(`💾 Saving inbound: "${emailData.subject}"`, {
            threadId,
            inReplyTo,
            references: references.length
          });

          // Upsert into MongoDB using remoteId + clientID as fallback
          const result = await Email.findOneAndUpdate(
            { 
              $or: [
                { uid: emailData.uid, clientID: client.clientID },
                { remoteId: emailData.remoteId, clientID: client.clientID }
              ].filter(condition => condition.uid || condition.remoteId)
            },
            emailData,
            { 
              upsert: true, 
              new: true,
              setDefaultsOnInsert: true 
            }
          );

          if (result.isNew) {
            newEmailsCount++;
            console.log(`✅ NEW: "${emailData.subject}"`);
          } else {
            console.log(`🔄 UPDATED: "${emailData.subject}"`);
          }

          // Update thread metadata
          await updateThreadMetadata(client.clientID, threadId);
          
          emails.push(emailData);
          processedCount++;

          if (processedCount % 10 === 0) {
            console.log(`⏳ Processed ${processedCount}/${totalMessages}...`);
          }
          
        } catch (parseError) {
          console.error('❌ Error parsing email:', parseError.message);
        }
      }
      
      console.log(`🎉 IMAP fetch completed: ${processedCount} processed, ${newEmailsCount} new`);
      
    } finally {
      lock.release();
    }

    return emails;

  } catch (error) {
    console.error('❌ IMAP fetch failed:', error.message);
    throw error;
  } finally {
    if (imap) {
      try {
        await imap.logout();
      } catch (logoutError) {}
    }
  }
}

/**
 * SIMPLE TEST - Basic connection test
 */
async function testImapConnection(client) {
  console.log('🧪 SIMPLE IMAP CONNECTION TEST');
  
  if (!client.businessEmail || !client.businessEmailPassword) {
    throw new Error('Client email or password not set');
  }

  let imap;
  try {
    let domain = 'example.com';
    if (client.return_url) {
      domain = client.return_url.replace(/^https?:\/\//, '').split('/')[0];
    }

    const host = client.imapHost || `mail.${domain}`;
    const port = client.imapPort || 993;

    console.log('Testing connection to:', { host, port, user: client.businessEmail });

    imap = new ImapFlow({
      host: host,
      port: port,
      secure: true,
      auth: { 
        user: client.businessEmail, 
        pass: client.businessEmailPassword 
      },
      logger: {
        debug: console.log,
        info: console.log,
        warn: console.warn,
        error: console.error
      }
    });

    await imap.connect();
    console.log('✅ CONNECTION SUCCESSFUL');

    await imap.mailboxOpen('INBOX');
    const totalMessages = imap.mailbox.exists || 0;
    console.log(`✅ INBOX ACCESS SUCCESSFUL - ${totalMessages} messages`);

    // Try to fetch first message to test
    if (totalMessages > 0) {
      for await (let msg of imap.fetch('1:*', { source: true, uid: true })) {
        console.log('✅ MESSAGE FETCH SUCCESSFUL - UID:', msg.uid);
        break; // Just test first message
      }
    }

    return {
      success: true,
      host,
      port,
      totalMessages,
      message: 'IMAP connection test successful'
    };

  } catch (error) {
    console.error('❌ CONNECTION TEST FAILED:', error.message);
    return {
      success: false,
      error: error.message,
      host: client.imapHost || `mail.${domain}`,
      port: client.imapPort || 993
    };
  } finally {
    if (imap) {
      try {
        await imap.logout();
      } catch (e) {}
    }
  }
}

/**
 * Add flags to an email via IMAP
 */
async function addFlags(client, uid, flags) {
  if (!client.businessEmail || !client.businessEmailPassword) {
    throw new Error('Client email or password not set');
  }

  let imap;
  try {
    let domain = 'example.com';
    if (client.return_url) {
      try {
        domain = client.return_url.replace(/^https?:\/\//, '').split('/')[0];
      } catch (e) {
        console.warn('Failed to parse domain from return_url:', client.return_url);
      }
    }

    const host = client.imapHost || `mail.${domain}`;
    console.log(`🏷️ Adding flags to email UID ${uid}: ${flags.join(', ')}`);

    imap = new ImapFlow({
      host: host,
      port: client.imapPort || 993,
      secure: true,
      auth: { 
        user: client.businessEmail, 
        pass: client.businessEmailPassword 
      },
      logger: false,
      disableAutoIdle: true,
      disableCompression: true,
    });

    await imap.connect();
    await imap.mailboxOpen('INBOX');

    const lock = await imap.getMailboxLock('INBOX');
    try {
      await imap.messageFlagsAdd(uid, flags);
      console.log(`✅ Successfully added flags to UID ${uid}`);
    } finally {
      lock.release();
    }

  } catch (error) {
    console.error(`❌ Failed to add flags to UID ${uid}:`, error.message);
    throw error;
  } finally {
    if (imap) {
      try {
        await imap.logout();
      } catch (logoutError) {}
    }
  }
}

/**
 * Remove flags from an email via IMAP
 */
async function removeFlags(client, uid, flags) {
  if (!client.businessEmail || !client.businessEmailPassword) {
    throw new Error('Client email or password not set');
  }

  let imap;
  try {
    let domain = 'example.com';
    if (client.return_url) {
      try {
        domain = client.return_url.replace(/^https?:\/\//, '').split('/')[0];
      } catch (e) {
        console.warn('Failed to parse domain from return_url:', client.return_url);
      }
    }

    const host = client.imapHost || `mail.${domain}`;
    console.log(`🏷️ Removing flags from email UID ${uid}: ${flags.join(', ')}`);

    imap = new ImapFlow({
      host: host,
      port: client.imapPort || 993,
      secure: true,
      auth: { 
        user: client.businessEmail, 
        pass: client.businessEmailPassword 
      },
      logger: false,
      disableAutoIdle: true,
      disableCompression: true,
    });

    await imap.connect();
    await imap.mailboxOpen('INBOX');

    const lock = await imap.getMailboxLock('INBOX');
    try {
      await imap.messageFlagsRemove(uid, flags);
      console.log(`✅ Successfully removed flags from UID ${uid}`);
    } finally {
      lock.release();
    }

  } catch (error) {
    console.error(`❌ Failed to remove flags from UID ${uid}:`, error.message);
    throw error;
  } finally {
    if (imap) {
      try {
        await imap.logout();
      } catch (logoutError) {}
    }
  }
}

/**
 * Set flags for an email via IMAP (replaces existing flags)
 */
async function setFlags(client, uid, flags) {
  if (!client.businessEmail || !client.businessEmailPassword) {
    throw new Error('Client email or password not set');
  }

  let imap;
  try {
    let domain = 'example.com';
    if (client.return_url) {
      try {
        domain = client.return_url.replace(/^https?:\/\//, '').split('/')[0];
      } catch (e) {
        console.warn('Failed to parse domain from return_url:', client.return_url);
      }
    }

    const host = client.imapHost || `mail.${domain}`;
    console.log(`🏷️ Setting flags for email UID ${uid}: ${flags.join(', ')}`);

    imap = new ImapFlow({
      host: host,
      port: client.imapPort || 993,
      secure: true,
      auth: { 
        user: client.businessEmail, 
        pass: client.businessEmailPassword 
      },
      logger: false,
      disableAutoIdle: true,
      disableCompression: true,
    });

    await imap.connect();
    await imap.mailboxOpen('INBOX');

    const lock = await imap.getMailboxLock('INBOX');
    try {
      await imap.messageFlagsSet(uid, flags);
      console.log(`✅ Successfully set flags for UID ${uid}`);
    } finally {
      lock.release();
    }

  } catch (error) {
    console.error(`❌ Failed to set flags for UID ${uid}:`, error.message);
    throw error;
  } finally {
    if (imap) {
      try {
        await imap.logout();
      } catch (logoutError) {}
    }
  }
}

/**
 * Debug threading for a client
 */
async function debugThreading(client) {
  console.log('🔍 DEBUG THREADING FOR CLIENT:', client.clientID);
  
  // Check what emails are in the database
  const emails = await Email.find({ clientID: client.clientID })
    .select('subject threadId remoteId inReplyTo references date')
    .sort({ date: 1 })
    .lean();
  
  console.log(`📧 Total emails in DB: ${emails.length}`);
  
  emails.forEach((email, index) => {
    console.log(`${index + 1}. "${email.subject}"`);
    console.log(`   ThreadId: ${email.threadId}`);
    console.log(`   RemoteId: ${email.remoteId}`);
    console.log(`   InReplyTo: ${email.inReplyTo}`);
    console.log(`   References: ${JSON.stringify(email.references)}`);
    console.log(`   Date: ${email.date}`);
    console.log('---');
  });

  // Check unique threads
  const uniqueThreads = await Email.aggregate([
    { $match: { clientID: client.clientID } },
    { $group: { _id: '$threadId', count: { $sum: 1 } } }
  ]);

  console.log('🧵 UNIQUE THREADS:', uniqueThreads);
}

/**
 * Recalculate all threads for a client
 */
async function recalculateAllThreads(clientID) {
  console.log(`🔄 Recalculating all threads for client: ${clientID}`);
  
  const emails = await Email.find({ clientID })
    .select('remoteId messageId inReplyTo references clientID subject')
    .sort({ date: 1 })
    .lean();

  let updatedCount = 0;

  for (const email of emails) {
    try {
      const threadId = await Email.computeThreadId({
        messageId: email.remoteId || email.messageId,
        inReplyTo: email.inReplyTo,
        references: email.references,
        clientID: email.clientID
      });

      if (threadId !== email.threadId) {
        await Email.updateOne(
          { _id: email._id },
          { $set: { threadId } }
        );
        updatedCount++;
        console.log(`✅ Updated thread for: "${email.subject}"`);
      }
    } catch (error) {
      console.error(`❌ Failed to update thread for: "${email.subject}"`, error);
    }
  }

  console.log(`🎉 Thread recalculation complete: ${updatedCount} emails updated`);
  return updatedCount;
}

// Export all functions
module.exports = { 
  fetchClientEmails, 
  addFlags,
  removeFlags,
  setFlags,
  updateThreadMetadata,
  testImapConnection,
  debugThreading,
  recalculateAllThreads
};