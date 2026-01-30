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
  messageId: { 
  type: String, 
  index: true,
  sparse: true 
},
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
    if (typeof references === 'string') {
      // Handle both space-separated and newline-separated references
      return references
        .replace(/\n/g, ' ')
        .split(' ')
        .map(ref => ref.trim().replace(/[<>]/g, ''))
        .filter(ref => ref.length > 0 && ref.includes('@'));
    }
    
    if (Array.isArray(references)) {
      return references
        .filter(ref => ref && typeof ref === 'string')
        .map(ref => ref.trim().replace(/[<>]/g, ''))
        .filter(ref => ref.includes('@'));
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
      messageId: messageId?.substring(0, 50),
      inReplyTo: inReplyTo?.substring(0, 50),
      references: references?.length || 0,
      clientID
    });

    // Clean message IDs
    const cleanMessageId = messageId ? messageId.replace(/[<>]/g, '') : null;
    const cleanInReplyTo = inReplyTo ? inReplyTo.replace(/[<>]/g, '') : null;
    
    // If this is a reply, use the parent's thread
    if (cleanInReplyTo) {
      console.log(`🔍 Looking for parent email: ${cleanInReplyTo}`);
      
      // Search for parent using multiple strategies
      const parentEmail = await this.findOne({ 
        $or: [
          { remoteId: cleanInReplyTo },
          { remoteId: { $regex: cleanInReplyTo, $options: 'i' } },
          { messageId: cleanInReplyTo },
          { messageId: { $regex: cleanInReplyTo, $options: 'i' } }
        ],
        clientID 
      });
      
      if (parentEmail) {
        console.log(`✅ Found parent: "${parentEmail.subject?.substring(0, 50)}..." - Thread: ${parentEmail.threadId}`);
        return parentEmail.threadId || cleanInReplyTo;
      } else {
        console.log(`❌ Parent not found, using inReplyTo as threadId: ${cleanInReplyTo}`);
        return cleanInReplyTo;
      }
    }

    // Check references for existing thread
    if (references && references.length > 0) {
      const cleanReferences = references.map(ref => ref.replace(/[<>]/g, ''));
      console.log(`🔍 Checking ${cleanReferences.length} references`);
      
      for (const ref of cleanReferences) {
        const refEmail = await this.findOne({
          $or: [
            { remoteId: ref },
            { remoteId: { $regex: ref, $options: 'i' } },
            { messageId: ref },
            { messageId: { $regex: ref, $options: 'i' } }
          ],
          clientID
        });
        
        if (refEmail && refEmail.threadId) {
          console.log(`✅ Found reference: "${refEmail.subject?.substring(0, 50)}..." - Thread: ${refEmail.threadId}`);
          return refEmail.threadId;
        }
      }
      
      console.log(`📌 No references found, using first reference as threadId: ${cleanReferences[0]}`);
      return cleanReferences[0];
    }

    // If this is a new message, use its own messageId
    const newThreadId = cleanMessageId || `thread-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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

// Add these static methods to your Email.js model (after the existing ones)

/**
 * Get Gmail-style threads for a client - FIXED VERSION
 */
EmailSchema.statics.getGmailStyleThreads = async function(clientID, page = 1, limit = 50, search = '') {
    try {
        const skip = (page - 1) * limit;
        
        // Build match conditions
        const matchConditions = { clientID };
        if (search) {
            matchConditions.$or = [
                { subject: { $regex: search, $options: 'i' } },
                { from: { $regex: search, $options: 'i' } },
                { to: { $regex: search, $options: 'i' } },
                { text: { $regex: search, $options: 'i' } }
            ];
        }

        // Get threads with message count and latest message
        const threads = await this.aggregate([
            { $match: matchConditions },
            {
                $sort: { date: -1 }
            },
            {
                $group: {
                    _id: '$threadId',
                    threadId: { $first: '$threadId' },
                    // Collect all subjects to find the original (non-reply) one
                    subjects: { $push: '$subject' },
                    originalSubject: { $first: '$subject' },
                    snippet: { 
                        $first: { 
                            $cond: [
                                { $gt: [{ $strLenCP: '$text' }, 0] },
                                { $substr: ['$text', 0, 150] },
                                { $substr: [{ $replaceAll: { input: '$html', find: '<[^>]*>', replacement: ' ' } }, 0, 150] }
                            ]
                        } 
                    },
                    hasAttachments: { $max: { $cond: [{ $gt: [{ $size: '$attachments' }, 0] }, 1, 0] } },
                    lastMessageAt: { $max: '$date' },
                    firstMessageAt: { $min: '$date' },
                    messageCount: { $sum: 1 },
                    unreadCount: {
                        $sum: {
                            $cond: [
                                { $in: ['\\Seen', '$flags'] },
                                0,  // If has \Seen flag, count as READ (0)
                                1   // If doesn't have \Seen flag, count as UNREAD (1)
                            ]
                        }
                    },
                    // FIXED: Collect ALL participants (both from and to for every email)
                    fromEmails: { $addToSet: '$from' },
                    toEmails: { $addToSet: '$to' },
                    labels: { $push: '$flags' },
                    messages: {
                        $push: {
                            _id: '$_id',
                            remoteId: '$remoteId',
                            from: '$from',
                            to: '$to',
                            subject: '$subject',
                            text: '$text',
                            html: '$html',
                            date: '$date',
                            direction: '$direction',
                            flags: '$flags',
                            attachments: '$attachments',
                            inReplyTo: '$inReplyTo',
                            references: '$references',
                            isThreadStarter: '$isThreadStarter',
                            uid: '$uid'
                        }
                    }
                }
            },
            {
                $project: {
                    _id: 0,
                    id: '$threadId',
                    threadId: 1,
                    subjects: 1,
                    originalSubject: 1,
                    snippet: { 
                        $concat: [
                            { 
                                $cond: [
                                    { $gt: [{ $strLenCP: '$snippet' }, 150] },
                                    { $substr: ['$snippet', 0, 150] },
                                    '$snippet'
                                ]
                            }, 
                            '...' 
                        ] 
                    },
                    hasAttachments: { $cond: [{ $eq: ['$hasAttachments', 1] }, true, false] },
                    date: '$lastMessageAt',
                    lastMessageAt: 1,
                    firstMessageAt: 1,
                    messageCount: 1,
                    unreadCount: 1,
                    fromEmails: 1,
                    toEmails: 1,
                    labels: {
                        $reduce: {
                            input: '$labels',
                            initialValue: [],
                            in: { 
                                $cond: [
                                    { $isArray: "$$this" },
                                    { $setUnion: ["$$value", "$$this"] },
                                    { $setUnion: ["$$value", ["$$this"]] }
                                ]
                            }
                        }
                    },
                    messages: {
                        $slice: ['$messages', 10] // Limit messages in preview
                    }
                }
            },
            { $sort: { lastMessageAt: -1 } },
            { $skip: skip },
            { $limit: parseInt(limit) }
        ]);

        // Process and clean up threads
        threads.forEach(thread => {
            // Find the original (non-reply) subject
            let originalSubject = thread.originalSubject;
            if (thread.subjects && thread.subjects.length > 0) {
                // Try to find a subject without "Re: " prefix
                const nonReplySubject = thread.subjects.find(subj => 
                    !subj.toLowerCase().startsWith('re:')
                );
                if (nonReplySubject) {
                    originalSubject = nonReplySubject;
                } else {
                    // If all are replies, remove "Re: " from the first one
                    originalSubject = thread.subjects[0].replace(/^Re:\s*/i, '');
                }
            }
            
            // Build participants from all from and to emails
            const participantsMap = new Map();
            
            // Process FROM emails
            if (thread.fromEmails && Array.isArray(thread.fromEmails)) {
                thread.fromEmails.forEach(email => {
                    if (email && email.trim() !== '') {
                        const cleanEmail = this.extractCleanEmail(email);
                        const displayName = this.extractDisplayName(email);
                        
                        if (cleanEmail) {
                            if (!participantsMap.has(cleanEmail)) {
                                participantsMap.set(cleanEmail, {
                                    email: cleanEmail,
                                    displayName: displayName || cleanEmail,
                                    types: new Set(['from']),
                                    roles: ['from']
                                });
                            } else {
                                const existing = participantsMap.get(cleanEmail);
                                existing.types.add('from');
                                existing.roles = Array.from(existing.types);
                                
                                // Use the better display name if available
                                if (displayName && displayName !== cleanEmail && existing.displayName === cleanEmail) {
                                    existing.displayName = displayName;
                                }
                            }
                        }
                    }
                });
            }
            
            // Process TO emails
            if (thread.toEmails && Array.isArray(thread.toEmails)) {
                thread.toEmails.forEach(email => {
                    if (email && email.trim() !== '') {
                        const cleanEmail = this.extractCleanEmail(email);
                        const displayName = this.extractDisplayName(email);
                        
                        if (cleanEmail) {
                            if (!participantsMap.has(cleanEmail)) {
                                participantsMap.set(cleanEmail, {
                                    email: cleanEmail,
                                    displayName: displayName || cleanEmail,
                                    types: new Set(['to']),
                                    roles: ['to']
                                });
                            } else {
                                const existing = participantsMap.get(cleanEmail);
                                existing.types.add('to');
                                existing.roles = Array.from(existing.types);
                                
                                // Use the better display name if available
                                if (displayName && displayName !== cleanEmail && existing.displayName === cleanEmail) {
                                    existing.displayName = displayName;
                                }
                            }
                        }
                    }
                });
            }
            
            // Convert to final array format
            thread.participants = Array.from(participantsMap.values()).map(p => ({
                email: p.email,
                displayName: p.displayName,
                roles: p.roles,
                isSender: p.roles.includes('from'),
                isRecipient: p.roles.includes('to')
            }));
            
            // Sort participants: senders first, then by display name
            thread.participants.sort((a, b) => {
                // Primary sort: senders first
                if (a.isSender && !b.isSender) return -1;
                if (!a.isSender && b.isSender) return 1;
                
                // Secondary sort: by display name
                return a.displayName.localeCompare(b.displayName);
            });
            
            // Clean up labels
            if (thread.labels && Array.isArray(thread.labels)) {
                thread.labels = thread.labels
                    .filter(label => label && label.trim() !== '')
                    .filter((label, index, self) => self.indexOf(label) === index)
                    .sort();
            }
            
            // Set the cleaned subject
            thread.subject = originalSubject.trim();
            
            // Ensure snippet ends with ...
            if (thread.snippet && !thread.snippet.endsWith('...')) {
                thread.snippet = thread.snippet + '...';
            }
            
            // Sort messages by date (newest first within thread preview)
            if (thread.messages && Array.isArray(thread.messages)) {
                thread.messages.sort((a, b) => new Date(b.date) - new Date(a.date));
            }
            
            // Clean email addresses in messages
            thread.messages.forEach(msg => {
                msg.cleanFrom = this.extractCleanEmail(msg.from);
                msg.cleanTo = this.extractCleanEmail(msg.to);
                msg.fromDisplay = this.extractDisplayName(msg.from);
                msg.toDisplay = this.extractDisplayName(msg.to);
                msg.isReply = !!(msg.inReplyTo && msg.inReplyTo.trim() !== '');
            });
            
            // Remove temporary fields
            delete thread.fromEmails;
            delete thread.toEmails;
        });

        // Get total thread count
        const totalThreads = await this.aggregate([
            { $match: { clientID } },
            { $group: { _id: '$threadId' } },
            { $count: 'total' }
        ]);

        return {
            threads,
            pagination: {
                page,
                limit,
                total: totalThreads[0]?.total || 0,
                pages: Math.ceil((totalThreads[0]?.total || 0) / limit)
            }
        };
    } catch (error) {
        console.error('Error getting Gmail-style threads:', error);
        throw error;
    }
};

/**
 * Get full thread with all messages
 */
EmailSchema.statics.getFullThread = async function(clientID, threadId) {
    try {
        const messages = await this.find({ clientID, threadId })
            .sort({ date: 1 })
            .lean();

        if (messages.length === 0) {
            return null;
        }

        // Process messages for thread view
        const processedMessages = messages.map((msg, index) => {
            const isReply = !!(msg.inReplyTo && msg.inReplyTo.trim() !== '');
            const isUnread = !(msg.flags || []).includes('\\Seen');
            
            // Determine if this is the thread starter
            let isThreadStarter = false;
            if (msg.isThreadStarter) {
                isThreadStarter = true;
            } else if (!isReply && index === 0) {
                // First message that's not a reply is thread starter
                isThreadStarter = true;
            } else if (!isReply) {
                // Check if this is the earliest non-reply message
                const earlierNonReplies = messages
                    .slice(0, index)
                    .filter(m => !m.inReplyTo || m.inReplyTo.trim() === '');
                isThreadStarter = earlierNonReplies.length === 0;
            }
            
            return {
                id: msg._id,
                messageId: msg.remoteId || msg.messageId,
                from: this.extractCleanEmail(msg.from),
                fromDisplay: this.extractDisplayName(msg.from),
                to: this.extractCleanEmail(msg.to),
                toDisplay: this.extractDisplayName(msg.to),
                cc: msg.cc ? this.extractCleanEmail(msg.cc) : '',
                ccDisplay: msg.cc ? this.extractDisplayName(msg.cc) : '',
                bcc: msg.bcc ? this.extractCleanEmail(msg.bcc) : '',
                bccDisplay: msg.bcc ? this.extractDisplayName(msg.bcc) : '',
                subject: msg.subject,
                text: msg.text,
                html: msg.html,
                date: msg.date,
                timestamp: msg.date.getTime(),
                direction: msg.direction,
                flags: msg.flags || [],
                attachments: msg.attachments || [],
                inReplyTo: msg.inReplyTo,
                references: msg.references || [],
                isThreadStarter: isThreadStarter,
                isReply: isReply,
                isUnread: isUnread,
                uid: msg.uid,
                position: index + 1,
                totalInThread: messages.length,
                raw: {
                    from: msg.from,
                    to: msg.to
                }
            };
        });

        // Get thread metadata
        const threadStarter = processedMessages.find(m => m.isThreadStarter) || processedMessages[0];
        const lastMessage = processedMessages[processedMessages.length - 1];
        
        // Collect all unique participants with their display names
        const participantDetails = [];
        const seenParticipants = new Set();
        
        processedMessages.forEach(msg => {
            // Add sender
            if (msg.from && !seenParticipants.has(`${msg.from}|from`)) {
                seenParticipants.add(`${msg.from}|from`);
                participantDetails.push({
                    email: msg.from,
                    displayName: msg.fromDisplay,
                    type: 'from'
                });
            }
            
            // Add recipient
            if (msg.to && !seenParticipants.has(`${msg.to}|to`)) {
                seenParticipants.add(`${msg.to}|to`);
                participantDetails.push({
                    email: msg.to,
                    displayName: msg.toDisplay,
                    type: 'to'
                });
            }
            
            // Add CC recipients if present
            if (msg.cc) {
                const ccEmails = msg.cc.split(',').map(e => e.trim()).filter(e => e);
                ccEmails.forEach(ccEmail => {
                    if (!seenParticipants.has(`${ccEmail}|cc`)) {
                        seenParticipants.add(`${ccEmail}|cc`);
                        participantDetails.push({
                            email: ccEmail,
                            displayName: this.extractDisplayName(ccEmail),
                            type: 'cc'
                        });
                    }
                });
            }
        });

        // Sort participants: from first, then to, then cc
        participantDetails.sort((a, b) => {
            const order = { 'from': 1, 'to': 2, 'cc': 3 };
            return (order[a.type] || 4) - (order[b.type] || 4);
        });

        // Get the original thread subject (without "Re: ")
        let threadSubject = threadStarter.subject;
        if (threadSubject.toLowerCase().startsWith('re:')) {
            // Try to find a non-reply subject in the thread
            const nonReplyMessage = processedMessages.find(m => !m.subject.toLowerCase().startsWith('re:'));
            if (nonReplyMessage) {
                threadSubject = nonReplyMessage.subject;
            } else {
                // Remove "Re: " from the subject
                threadSubject = threadSubject.replace(/^Re:\s*/i, '');
            }
        }

        return {
            threadId,
            subject: threadSubject.trim(),
            originalSubject: threadStarter.subject,
            messageCount: messages.length,
            unreadCount: processedMessages.filter(m => m.isUnread).length,
            participantDetails: participantDetails,
            dateStarted: threadStarter.date,
            lastUpdated: lastMessage.date,
            hasAttachments: processedMessages.some(m => (m.attachments || []).length > 0),
            labels: processedMessages.flatMap(m => m.flags || []).filter((v, i, a) => a.indexOf(v) === i),
            messages: processedMessages,
            timeline: processedMessages.map(m => ({
                date: m.date,
                from: m.fromDisplay,
                fromEmail: m.from,
                action: m.direction === 'inbound' ? 'received' : 'sent',
                subject: m.subject,
                isUnread: m.isUnread,
                isReply: m.isReply
            })),
            metadata: {
                threadStarterId: threadStarter.id,
                lastMessageId: lastMessage.id,
                hasOutbound: processedMessages.some(m => m.direction === 'outbound'),
                hasInbound: processedMessages.some(m => m.direction === 'inbound'),
                replyCount: processedMessages.filter(m => m.isReply).length
            }
        };
    } catch (error) {
        console.error('Error getting full thread:', error);
        throw error;
    }
};


// Add these static methods to your EmailSchema.statics object:

/**
 * Extract clean email address from formatted string
 */
EmailSchema.statics.extractCleanEmail = function(emailString) {
    if (!emailString || typeof emailString !== 'string') return '';
    
    const trimmed = emailString.trim();
    if (trimmed === '') return '';
    
    // Extract email from "Name <email@domain.com>" format
    const emailMatch = trimmed.match(/<([^>]+)>/);
    if (emailMatch && emailMatch[1]) {
        return emailMatch[1].trim();
    }
    
    // Return as is if no angle brackets
    return trimmed;
};

/**
 * Extract display name from formatted email string
 */
EmailSchema.statics.extractDisplayName = function(emailString) {
    if (!emailString || typeof emailString !== 'string') return '';
    
    const trimmed = emailString.trim();
    if (trimmed === '') return '';
    
    // Extract name from "Name <email@domain.com>" format
    const nameMatch = trimmed.match(/^"?([^"<]+)"?\s*</);
    if (nameMatch && nameMatch[1]) {
        return nameMatch[1].trim();
    }
    
    // If no name found, return the clean email
    return this.extractCleanEmail(trimmed);
};

/**
 * Format email for display
 */
EmailSchema.statics.formatEmailForDisplay = function(emailString, includeName = true) {
    if (!emailString) return '';
    
    const cleanEmail = this.extractCleanEmail(emailString);
    const displayName = this.extractDisplayName(emailString);
    
    if (includeName && displayName && displayName !== cleanEmail) {
        return `${displayName} <${cleanEmail}>`;
    }
    
    return cleanEmail;
};

module.exports = mongoose.model('Email', EmailSchema);