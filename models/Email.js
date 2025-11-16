// models/Email.js
const mongoose = require('mongoose');

const AttachmentSchema = new mongoose.Schema({
  filename: String,
  contentType: String,
  size: Number,
  contentId: String,
  cid: String
}, { _id: false });

const EmailSchema = new mongoose.Schema({
  uid: { 
    type: Number, 
    index: true, 
    sparse: true 
  }, // IMAP UID - sparse index allows nulls
  remoteId: { 
    type: String, 
    index: true, 
    sparse: true 
  }, // message-id
  clientID: { 
    type: String, 
    required: true, 
    index: true 
  },
  from: String,
  to: String,
  cc: String,
  bcc: String,
  subject: String,
  text: String,
  html: String,
  date: { type: Date, default: Date.now },
  flags: [String],
  attachments: [AttachmentSchema],
  direction: { 
    type: String, 
    enum: ['inbound','outbound'], 
    default: 'inbound' 
  },
  
  // THREAD SUPPORT FIELDS
  threadId: { 
    type: String, 
    index: true,
    sparse: true 
  },
  inReplyTo: { 
    type: String, 
    index: true,
    sparse: true 
  },
  references: [String],
  isThreadStarter: { 
    type: Boolean, 
    default: false 
  },
  threadCount: { 
    type: Number, 
    default: 1 
  },
  lastMessageAt: { 
    type: Date, 
    default: Date.now 
  }
}, { timestamps: true });

// Compound index only applies when uid is not null
EmailSchema.index({ uid: 1, clientID: 1 }, { 
  unique: true, 
  sparse: true,
  partialFilterExpression: { uid: { $type: "number" } }
});

// Alternative unique index for sent emails (without uid)
EmailSchema.index({ remoteId: 1, clientID: 1 }, { 
  unique: true, 
  sparse: true 
});

// Index for thread queries
EmailSchema.index({ clientID: 1, threadId: 1 });
EmailSchema.index({ clientID: 1, inReplyTo: 1 });

// ============================================================================
// STATIC METHODS FOR THREADING AND EMAIL OPERATIONS
// ============================================================================

/**
 * Generate a unique message ID
 */
EmailSchema.statics.generateMessageId = function(domain = 'herbeauty.co.za') {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substr(2, 9);
  return `<${timestamp}.${random}@${domain}>`;
};

/**
 * Parse references header into array of message IDs
 */
EmailSchema.statics.parseReferences = function(references) {
  if (!references) return [];
  
  try {
    // Handle string of space-separated message IDs
    if (typeof references === 'string') {
      return references
        .split(' ')
        .map(ref => ref.trim())
        .filter(ref => ref.length > 0);
    }
    
    // Handle array
    if (Array.isArray(references)) {
      return references.filter(ref => ref && typeof ref === 'string');
    }
    
    return [];
  } catch (error) {
    console.error('Error parsing references:', error);
    return [];
  }
};

/**
 * Compute thread ID from message threading headers
 */
EmailSchema.statics.computeThreadId = async function({ messageId, inReplyTo, references, clientID }) {
  try {
    console.log(`🧵 Computing threadId for:`, {
      messageId,
      inReplyTo,
      references: references?.length || 0,
      clientID
    });

    // If this is a reply, use the parent's thread
    if (inReplyTo) {
      console.log(`🔍 Looking for parent email: ${inReplyTo}`);
      const parentEmail = await this.findOne({ 
        $or: [
          { remoteId: inReplyTo },
          { messageId: inReplyTo }
        ],
        clientID 
      });
      
      if (parentEmail) {
        console.log(`✅ Found parent: "${parentEmail.subject}" - Thread: ${parentEmail.threadId}`);
        return parentEmail.threadId;
      } else {
        console.log(`❌ Parent not found, using inReplyTo as threadId: ${inReplyTo}`);
        return inReplyTo;
      }
    }

    // Check references for existing thread
    if (references && references.length > 0) {
      console.log(`🔍 Checking references: ${references.join(', ')}`);
      for (const ref of references) {
        const refEmail = await this.findOne({
          $or: [
            { remoteId: ref },
            { messageId: ref }
          ],
          clientID
        });
        
        if (refEmail && refEmail.threadId) {
          console.log(`✅ Found reference: "${refEmail.subject}" - Thread: ${refEmail.threadId}`);
          return refEmail.threadId;
        }
      }
      console.log(`📌 No references found, using first reference: ${references[0]}`);
      return references[0];
    }

    // If this is a new message, use its own messageId
    const newThreadId = messageId || `thread-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    console.log(`🆕 New thread created: ${newThreadId}`);
    return newThreadId;
    
  } catch (error) {
    console.error('❌ Error computing threadId:', error);
    return messageId || `thread-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
};

/**
 * Format email addresses for headers
 */
EmailSchema.statics.formatAddresses = function(addresses) {
  if (!addresses) return '';
  if (Array.isArray(addresses)) {
    return addresses.map(addr => {
      if (typeof addr === 'string') return addr;
      if (addr.address) return `${addr.name || ''} <${addr.address}>`.trim();
      return '';
    }).filter(addr => addr).join(', ');
  }
  return addresses;
};

/**
 * Create email headers for threading
 */
EmailSchema.statics.createThreadHeaders = function(originalEmail, newMessageId) {
  const references = [...(originalEmail.references || [])];
  
  // Add original message ID to references if not already there
  const originalId = originalEmail.remoteId || originalEmail.messageId;
  if (originalId && !references.includes(originalId)) {
    references.push(originalId);
  }
  
  const headers = {
    'Message-ID': newMessageId,
    'In-Reply-To': originalId,
    'References': references.filter(Boolean).join(' ')
  };
  
  return headers;
};

/**
 * Find or create thread for an email
 */
EmailSchema.statics.findOrCreateThread = async function(emailData) {
  const { clientID, inReplyTo, references, remoteId } = emailData;
  
  const threadId = await this.computeThreadId({
    messageId: remoteId,
    inReplyTo,
    references,
    clientID
  });
  
  return threadId;
};

/**
 * Update thread metadata for all emails in a thread
 */
EmailSchema.statics.updateThreadMetadata = async function(clientID, threadId) {
  try {
    if (!threadId) {
      console.log('❌ No threadId provided for metadata update');
      return;
    }

    const threadEmails = await this.find({ clientID, threadId })
      .select('from to subject date threadId')
      .sort({ date: 1 })
      .lean();

    const threadCount = threadEmails.length;
    
    if (threadCount === 0) {
      console.log(`❌ No emails found for thread: ${threadId}`);
      return;
    }

    // Get unique participants
    const participants = {
      from: [...new Set(threadEmails.map(e => e.from).filter(Boolean))],
      to: [...new Set(threadEmails.map(e => e.to).filter(Boolean))],
    };

    const lastMessage = threadEmails[threadEmails.length - 1];
    const firstMessage = threadEmails[0];

    console.log(`📊 Updating thread metadata: ${threadId} (${threadCount} messages)`);
    console.log(`   First: "${firstMessage.subject}"`);
    console.log(`   Last: "${lastMessage.subject}"`);
    console.log(`   Participants: ${participants.from.join(', ')}`);

    // Update all emails in the thread with current metadata
    await this.updateMany(
      { clientID, threadId },
      { 
        $set: { 
          threadCount,
          lastMessageAt: lastMessage.date,
          threadUpdatedAt: new Date()
        }
      }
    );
    
    // Mark the thread starter
    if (threadCount > 0) {
      await this.updateOne(
        { _id: firstMessage._id },
        { $set: { isThreadStarter: true } }
      );
      
      // Ensure other messages in thread don't have isThreadStarter
      await this.updateMany(
        { clientID, threadId, _id: { $ne: firstMessage._id } },
        { $set: { isThreadStarter: false } }
      );
    }

  } catch (error) {
    console.error('❌ Error updating thread metadata:', error.message);
  }
};

module.exports = mongoose.model('Email', EmailSchema);