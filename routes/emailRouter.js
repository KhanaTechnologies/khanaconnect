// routes/emailRouter.js
const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const Email = require('../models/Email');
const EmailSubscriber = require('../models/emailSubscriber');
const { sendMail, sendMailWithRetry } = require('../helpers/mailer');
const { wrapRoute } = require('../helpers/failureEmail');
const { fetchClientEmails, addFlags, removeFlags } = require('../helpers/imapService');
const NewsletterService = require('../helpers/newsletterService');
const Client = require('../models/client');

const router = express.Router();

// Helper function for extracting clean email (add this to routes/emailRouter.js)
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

// --- Multer setup for attachments ---
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

// --- JWT Middleware ---
async function validateClient(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ ok: false, message: 'Unauthorized - No token provided' });
    }

    const token = authHeader.split(' ')[1];
    try {
        // Verify JWT
        const payload = jwt.verify(token, process.env.secret);
        if (!payload.clientID) {
            return res.status(403).json({ ok: false, message: 'Forbidden - Invalid token' });
        }
        console.log('here is the clientID:',payload.clientID);
        // Lookup client in MongoDB
        const client = await Client.findOne({ clientID: payload.clientID });
        if (!client) {
            return res.status(404).json({ ok: false, message: 'Client not found' });
        }

        // Attach client info to request
        req.client = {
            clientID: client.clientID,
            companyName: client.companyName,
            businessEmail: client.businessEmail,
            businessEmailPassword: client.businessEmailPassword,
            emailSignature: client.emailSignature || '',
            imapHost: client.imapHost,
            imapPort: client.imapPort,
            return_url: client.return_url
        };

        next();
    } catch (err) {
        return res.status(401).json({ ok: false, message: 'Unauthorized - Invalid token', error: err.message });
    }
}

// --- Thread Helper Function ---
async function updateThreadMetadata(clientID, threadId) {
    try {
        // Use the improved method from Email model
        await Email.updateThreadMetadata(clientID, threadId);
    } catch (error) {
        console.error('Error updating thread metadata:', error.message);
    }
}

// ============================================================================
// UNIFIED EMAIL API ENDPOINT - Gmail-style interface
// ============================================================================

/**
 * MAIN UNIFIED EMAIL API
 * Supports: GET (list/fetch), POST (send), PUT (update), DELETE (delete)
 */
router.route('/')
    // GET: List emails/threads (like Gmail API)
    .get(validateClient, wrapRoute(async (req, res) => {
        try {
            const {
                view = 'threads', // 'threads', 'messages', or 'thread'
                format = 'gmail', // 'gmail' or 'simple'
                page = 1,
                limit = 50,
                search = '',
                label = '',
                threadId: specificThreadId = '',
                refresh = false,
                includeSpamTrash = false,
                maxResults = 50
            } = req.query;

            console.log(`📧 Unified GET request:`, {
                view,
                format,
                page,
                limit,
                search,
                label,
                specificThreadId,
                refresh,
                clientID: req.client.clientID
            });

            // Refresh emails from IMAP if requested
            if (refresh === 'true' || refresh === true) {
                console.log('🔄 Refreshing emails from IMAP...');
                try {
                    const imapEmails = await fetchClientEmails(req.client);
                    console.log(`✅ Fetched ${Array.isArray(imapEmails) ? imapEmails.length : 0} new emails from IMAP`);
                } catch (error) {
                    console.error('❌ IMAP refresh failed:', error.message);
                    // Continue with database retrieval
                }
            }

            // Prepare base query
            const baseQuery = { clientID: req.client.clientID };
            
            // Handle specific thread request
            if (specificThreadId) {
                console.log(`📨 Fetching specific thread: ${specificThreadId}`);
                
                const thread = await Email.getFullThread(req.client.clientID, specificThreadId);
                
                if (!thread) {
                    return res.status(404).json({
                        ok: false,
                        message: 'Thread not found'
                    });
                }

                // Mark as read if requested
                const markAsRead = req.query.markAsRead === 'true';
                if (markAsRead && thread.unreadCount > 0) {
                    await Email.updateMany(
                        { 
                            clientID: req.client.clientID, 
                            threadId: specificThreadId,
                            flags: { $nin: ['\\Seen'] }
                        },
                        { $addToSet: { flags: '\\Seen' } }
                    );
                    
                    // Update thread data
                    thread.unreadCount = 0;
                    thread.messages.forEach(msg => {
                        msg.isUnread = false;
                        if (!msg.flags.includes('\\Seen')) {
                            msg.flags.push('\\Seen');
                        }
                    });
                }

                return res.json({
                    ok: true,
                    data: thread,
                    view: 'thread',
                    format,
                    clientID: req.client.clientID,
                    timestamp: new Date().toISOString()
                });
            }

            // Handle different views
            if (view === 'threads' || view === 'gmail') {
                // Get Gmail-style threads
                const result = await Email.getGmailStyleThreads(
                    req.client.clientID,
                    parseInt(page),
                    parseInt(limit),
                    search
                );

                // Apply label filter
                if (label) {
                    result.threads = result.threads.filter(thread => 
                        thread.labels && thread.labels.some(l => 
                            l.toUpperCase() === label.toUpperCase()
                        )
                    );
                    result.pagination.total = result.threads.length;
                    result.pagination.pages = Math.ceil(result.threads.length / limit);
                }

                return res.json({
                    ok: true,
                    data: result,
                    view: 'threads',
                    format: 'gmail',
                    clientID: req.client.clientID,
                    timestamp: new Date().toISOString()
                });

            } else if (view === 'messages') {
                // Get individual messages
                const messagesPage = Math.max(1, parseInt(page));
                const messagesLimit = Math.min(200, Math.max(5, parseInt(limit)));
                const skip = (messagesPage - 1) * messagesLimit;

                let messagesQuery = { ...baseQuery };
                
                // Add search filter
                if (search) {
                    messagesQuery.$or = [
                        { subject: { $regex: search, $options: 'i' } },
                        { from: { $regex: search, $options: 'i' } },
                        { to: { $regex: search, $options: 'i' } },
                        { text: { $regex: search, $options: 'i' } },
                        { html: { $regex: search, $options: 'i' } }
                    ];
                }

                // Add label filter
                if (label) {
                    messagesQuery.flags = label;
                }

                const totalMessages = await Email.countDocuments(messagesQuery);
                
                const messages = await Email.find(messagesQuery)
                    .sort({ date: -1 })
                    .skip(skip)
                    .limit(messagesLimit)
                    .lean();

                const inboundCount = await Email.countDocuments({ 
                    clientID: req.client.clientID, 
                    direction: 'inbound' 
                });
                const outboundCount = await Email.countDocuments({ 
                    clientID: req.client.clientID, 
                    direction: 'outbound' 
                });

                return res.json({
                    ok: true,
                    data: {
                        messages,
                        pagination: {
                            page: messagesPage,
                            limit: messagesLimit,
                            total: totalMessages,
                            pages: Math.ceil(totalMessages / messagesLimit)
                        },
                        summary: {
                            total: totalMessages,
                            inbound: inboundCount,
                            outbound: outboundCount,
                            showing: messages.length
                        }
                    },
                    view: 'messages',
                    format,
                    clientID: req.client.clientID,
                    timestamp: new Date().toISOString()
                });
            }

            // Default response
            res.json({
                ok: true,
                message: 'Use view=threads or view=messages',
                clientID: req.client.clientID
            });

        } catch (error) {
            console.error('❌ Unified GET failed:', error.message);
            res.status(500).json({
                ok: false,
                message: 'Failed to fetch emails',
                error: error.message
            });
        }
    }))
    
    // POST: Send new email or reply (using JSON data) - FIXED VERSION
.post(validateClient, wrapRoute(async (req, res) => {
    try {
        // Add delay to prevent SMTP connection limits
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        await delay(1000);

        const { 
            to, 
            subject, 
            html, 
            text,
            inReplyTo, 
            threadId, 
            references = [],
            action = 'send', // 'send', 'reply', 'replyAll', 'forward'
            attachments = [], // Base64 encoded attachments
            cc = '',
            bcc = ''
        } = req.body;

        console.log(`📧 Email action: ${action}`, {
            to,
            subject: subject?.substring(0, 50),
            hasInReplyTo: !!inReplyTo,
            hasThreadId: !!threadId,
            attachmentsCount: attachments?.length || 0
        });

        // Validate required fields
        if (!to) {
            return res.status(400).json({
                ok: false,
                message: 'Recipient (to) is required'
            });
        }

        if (!subject && action !== 'reply' && action !== 'replyAll') {
            return res.status(400).json({
                ok: false,
                message: 'Subject is required'
            });
        }

        if (!html && !text) {
            return res.status(400).json({
                ok: false,
                message: 'Email content (html or text) is required'
            });
        }

        let originalEmail = null;
        let finalTo = to;
        let finalCc = cc;
        let finalBcc = bcc;
        let finalSubject = subject;
        let finalReferences = Array.isArray(references) ? references : Email.parseReferences(references);
        let finalThreadId = threadId;

        // Handle different actions
        if (action === 'reply' || action === 'replyAll') {
            // Find original email
            if (inReplyTo) {
                originalEmail = await Email.findOne({
                    $or: [
                        { remoteId: inReplyTo },
                        { _id: inReplyTo }
                    ],
                    clientID: req.client.clientID
                });
            } else if (threadId) {
                originalEmail = await Email.findOne({
                    threadId,
                    clientID: req.client.clientID
                }).sort({ date: -1 });
            }

            if (!originalEmail) {
                return res.status(404).json({
                    ok: false,
                    message: 'Original email not found for reply'
                });
            }

            // Set recipient(s)
            if (action === 'reply') {
                finalTo = originalEmail.from;
                finalCc = '';
                finalBcc = '';
            } else if (action === 'replyAll') {
                // Combine original to, cc, and from (excluding current user)
                const recipients = {
                    to: new Set(),
                    cc: new Set(),
                    bcc: new Set()
                };
                
                // Parse original recipients
                if (originalEmail.to) {
                    originalEmail.to.split(',').forEach(email => recipients.to.add(email.trim()));
                }
                if (originalEmail.cc) {
                    originalEmail.cc.split(',').forEach(email => recipients.cc.add(email.trim()));
                }
                if (originalEmail.from) {
                    recipients.to.add(originalEmail.from.trim());
                }
                
                // Remove current user
                const currentUserEmail = req.client.businessEmail;
                recipients.to.delete(currentUserEmail);
                recipients.cc.delete(currentUserEmail);
                recipients.bcc.delete(currentUserEmail);
                
                // Convert to strings
                finalTo = Array.from(recipients.to).join(', ');
                finalCc = Array.from(recipients.cc).join(', ');
                finalBcc = Array.from(recipients.bcc).join(', ');
                
                // If we have cc from the request, add it
                if (cc) {
                    cc.split(',').forEach(email => {
                        const trimmedEmail = email.trim();
                        if (trimmedEmail && trimmedEmail !== currentUserEmail) {
                            recipients.cc.add(trimmedEmail);
                        }
                    });
                    finalCc = Array.from(recipients.cc).join(', ');
                }
            }

            // Set subject
            finalSubject = originalEmail.subject.startsWith('Re:') 
                ? originalEmail.subject 
                : `Re: ${originalEmail.subject}`;

            // Build references
            finalReferences = [
                ...(originalEmail.references || []),
                originalEmail.remoteId || originalEmail.messageId
            ].filter(Boolean);

            // Set thread ID
            finalThreadId = originalEmail.threadId || originalEmail.remoteId;

            console.log(`📨 Replying to: "${originalEmail.subject}"`, {
                threadId: finalThreadId,
                referencesCount: finalReferences.length,
                to: finalTo,
                cc: finalCc
            });
        } else if (action === 'forward') {
            // Handle forward action
            if (inReplyTo || threadId) {
                originalEmail = await Email.findOne({
                    $or: [
                        { remoteId: inReplyTo },
                        { _id: inReplyTo },
                        { threadId: threadId }
                    ],
                    clientID: req.client.clientID
                });

                if (originalEmail) {
                    finalSubject = `Fwd: ${originalEmail.subject}`;
                    finalThreadId = `fwd-${Date.now()}`; // New thread for forwarded emails
                    
                    // Include original content in forward
                    const forwardHeader = `<br><br>---------- Forwarded message ----------<br>
                    From: ${originalEmail.from}<br>
                    Date: ${originalEmail.date}<br>
                    Subject: ${originalEmail.subject}<br>
                    To: ${originalEmail.to}<br>`;
                    
                    const forwardCc = originalEmail.cc ? `<br>Cc: ${originalEmail.cc}` : '';
                    
                    html = forwardHeader + forwardCc + `<br><br>` + (html || '');
                }
            }
        }

        // Process attachments from base64
        const processedAttachments = [];
        if (Array.isArray(attachments)) {
            attachments.forEach((att, index) => {
                if (att.filename && att.content) {
                    // Convert base64 to buffer
                    const contentBuffer = Buffer.from(att.content, 'base64');
                    processedAttachments.push({
                        filename: att.filename,
                        content: contentBuffer,
                        contentType: att.contentType || 'application/octet-stream'
                    });
                }
            });
        }

        // Add email signature
        const clientSignature = req.client.emailSignature || '';
        const finalHtml = html + (clientSignature ? `<br><br>${clientSignature}` : '');

        // Generate plain text fallback
        const finalText = text || finalHtml
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]*>/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        // Get SMTP configuration
        const domain = req.client.return_url?.replace(/^https?:\/\//, '').split('/')[0];
        const host = req.client.imapHost?.replace(/^mail\./, 'smtp.')?.replace(/^imap\./, 'smtp.') || `smtp.${domain}`;

        // Send email using the updated sendMailWithRetry
        let result;
        try {
            const mailOptions = {
                host: host,
                port: 587,
                secure: false,
                user: req.client.businessEmail,
                pass: req.client.businessEmailPassword,
                from: `"${req.client.companyName}" <${req.client.businessEmail}>`,
                to: finalTo,
                subject: finalSubject,
                text: finalText,
                html: finalHtml,
                attachments: processedAttachments,
                inReplyTo: action === 'send' ? undefined : (originalEmail?.remoteId || inReplyTo),
                references: finalReferences,
                cc: finalCc || undefined,
                bcc: finalBcc || undefined,
                clientID: req.client.clientID,
                saveToSent: true
            };

            result = await sendMailWithRetry(mailOptions, 3); // 3 retries
            
            console.log(`✅ Email sent successfully with Message-ID: ${result.messageId}`);
        } catch (error) {
            console.error('❌ SMTP failed:', error.message);
            return res.status(500).json({
                ok: false,
                message: 'Failed to send email. Please try again in a moment.',
                error: error.message
            });
        }

        // Determine final thread ID if not already set
        if (!finalThreadId) {
            finalThreadId = result.messageId;
        }

        // Prepare response
        const response = {
            ok: true,
            message: `Email ${action}ed successfully`,
            data: {
                messageId: result.messageId,
                threadId: finalThreadId,
                to: finalTo,
                cc: finalCc,
                bcc: finalBcc,
                subject: finalSubject,
                timestamp: new Date().toISOString(),
                action: action,
                savedToSentFolder: true
            }
        };

        // Mark original as answered if it's a reply
        if ((action === 'reply' || action === 'replyAll') && originalEmail?.uid) {
            try {
                const { addFlags } = require('../helpers/imapService');
                await addFlags(req.client, originalEmail.uid, ['\\Answered', '\\Seen']);
                console.log('✅ Original email marked as answered in IMAP');
            } catch (e) {
                console.warn('⚠️ Failed to mark original email as answered:', e.message);
            }
        }

        // Update thread metadata
        await Email.updateThreadMetadata(req.client.clientID, finalThreadId);

        res.json(response);

    } catch (error) {
        console.error('❌ Email POST failed:', error.message);
        res.status(500).json({
            ok: false,
            message: 'Failed to process email request',
            error: error.message
        });
    }
}))
    
    // PUT: Update email (mark as read/unread, add labels, move to trash, etc.)
    .put(validateClient, wrapRoute(async (req, res) => {
        try {
            const { 
                ids = [], // Array of email IDs or thread IDs
                threadIds = [],
                action, // 'markRead', 'markUnread', 'addLabel', 'removeLabel', 'trash', 'archive', 'spam'
                label,
                labels = [],
                destination,
                removeLabel
            } = req.body;

            console.log(`✏️ Email UPDATE action: ${action}`, {
                emailIds: ids.length,
                threadIds: threadIds.length,
                label,
                labels
            });

            let result = { modifiedCount: 0 };
            let emailIdsToUpdate = [...ids];

            // If thread IDs are provided, get all email IDs in those threads
            if (threadIds.length > 0) {
                const emailsInThreads = await Email.find({
                    clientID: req.client.clientID,
                    threadId: { $in: threadIds }
                }).select('_id uid');
                
                emailIdsToUpdate = [
                    ...emailIdsToUpdate,
                    ...emailsInThreads.map(e => e._id.toString())
                ];
            }

            // Remove duplicates
            emailIdsToUpdate = [...new Set(emailIdsToUpdate)];

            if (emailIdsToUpdate.length === 0) {
                return res.status(400).json({
                    ok: false,
                    message: 'No email IDs or thread IDs provided'
                });
            }

            // Prepare update operations based on action
            let updateOperation = {};
            let imapFlagsToAdd = [];
            let imapFlagsToRemove = [];

            switch (action) {
                case 'markRead':
                    updateOperation = { $addToSet: { flags: '\\Seen' } };
                    imapFlagsToAdd = ['\\Seen'];
                    break;
                    
                case 'markUnread':
                    updateOperation = { $pull: { flags: '\\Seen' } };
                    imapFlagsToRemove = ['\\Seen'];
                    break;
                    
                case 'addLabel':
                    if (!label && (!labels || labels.length === 0)) {
                        return res.status(400).json({
                            ok: false,
                            message: 'Label or labels array required for addLabel action'
                        });
                    }
                    const labelsToAdd = label ? [label] : labels;
                    updateOperation = { $addToSet: { flags: { $each: labelsToAdd } } };
                    imapFlagsToAdd = labelsToAdd;
                    break;
                    
                case 'removeLabel':
                    if (!removeLabel && (!labels || labels.length === 0)) {
                        return res.status(400).json({
                            ok: false,
                            message: 'Label to remove or labels array required for removeLabel action'
                        });
                    }
                    const labelsToRemove = removeLabel ? [removeLabel] : labels;
                    updateOperation = { $pull: { flags: { $in: labelsToRemove } } };
                    imapFlagsToRemove = labelsToRemove;
                    break;
                    
                case 'trash':
                    updateOperation = { $addToSet: { flags: '\\Trash' } };
                    imapFlagsToAdd = ['\\Trash'];
                    break;
                    
                case 'archive':
                    updateOperation = { $pull: { flags: '\\Trash' } };
                    imapFlagsToRemove = ['\\Trash'];
                    break;
                    
                case 'spam':
                    updateOperation = { $addToSet: { flags: '\\Spam' } };
                    imapFlagsToAdd = ['\\Spam'];
                    break;
                    
                default:
                    return res.status(400).json({
                        ok: false,
                        message: 'Invalid action. Use: markRead, markUnread, addLabel, removeLabel, trash, archive, spam'
                    });
            }

            // Update in database
            result = await Email.updateMany(
                {
                    _id: { $in: emailIdsToUpdate },
                    clientID: req.client.clientID
                },
                updateOperation
            );

            // Update in IMAP (for emails with UIDs)
            const emailsWithUid = await Email.find({
                _id: { $in: emailIdsToUpdate },
                clientID: req.client.clientID,
                uid: { $exists: true, $ne: null }
            }).select('uid');

            let imapUpdates = 0;
            for (const email of emailsWithUid) {
                try {
                    if (imapFlagsToAdd.length > 0) {
                        await addFlags(req.client, email.uid, imapFlagsToAdd);
                    }
                    if (imapFlagsToRemove.length > 0) {
                        await removeFlags(req.client, email.uid, imapFlagsToRemove);
                    }
                    imapUpdates++;
                } catch (e) {
                    console.warn(`⚠️ Could not update IMAP flags for UID ${email.uid}:`, e.message);
                }
            }

            res.json({
                ok: true,
                message: `Action '${action}' completed successfully`,
                data: {
                    database: { modified: result.modifiedCount },
                    imap: { updated: imapUpdates },
                    totalEmails: emailIdsToUpdate.length
                }
            });

        } catch (error) {
            console.error('❌ Email UPDATE failed:', error.message);
            res.status(500).json({
                ok: false,
                message: 'Failed to update emails',
                error: error.message
            });
        }
    }))
    
    // DELETE: Delete emails
    .delete(validateClient, wrapRoute(async (req, res) => {
        try {
            const { 
                ids = [], // Array of email IDs
                threadIds = [], // Array of thread IDs
                permanent = false // If true, delete from database; if false, move to trash
            } = req.query;

            console.log(`🗑️ Email DELETE request:`, {
                emailIds: ids.length,
                threadIds: threadIds.length,
                permanent
            });

            let emailIdsToProcess = [...ids];

            // If thread IDs are provided, get all email IDs in those threads
            if (threadIds.length > 0) {
                const emailsInThreads = await Email.find({
                    clientID: req.client.clientID,
                    threadId: { $in: threadIds }
                }).select('_id uid');
                
                emailIdsToProcess = [
                    ...emailIdsToProcess,
                    ...emailsInThreads.map(e => e._id.toString())
                ];
            }

            // Remove duplicates
            emailIdsToProcess = [...new Set(emailIdsToProcess)];

            if (emailIdsToProcess.length === 0) {
                return res.status(400).json({
                    ok: false,
                    message: 'No email IDs or thread IDs provided'
                });
            }

            let result;

            if (permanent) {
                // Permanent deletion from database
                result = await Email.deleteMany({
                    _id: { $in: emailIdsToProcess },
                    clientID: req.client.clientID
                });
                
                // TODO: Also delete from IMAP (requires IMAP DELETE command)
                console.log(`⚠️ IMAP deletion not implemented yet. Emails deleted from database only.`);
                
                res.json({
                    ok: true,
                    message: 'Emails permanently deleted',
                    data: {
                        deletedCount: result.deletedCount,
                        totalRequested: emailIdsToProcess.length
                    }
                });
            } else {
                // Move to trash (soft delete)
                result = await Email.updateMany(
                    {
                        _id: { $in: emailIdsToProcess },
                        clientID: req.client.clientID
                    },
                    { $addToSet: { flags: '\\Trash' } }
                );

                // Update IMAP flags to add \Trash
                const emailsWithUid = await Email.find({
                    _id: { $in: emailIdsToProcess },
                    clientID: req.client.clientID,
                    uid: { $exists: true, $ne: null }
                }).select('uid');

                let imapUpdates = 0;
                for (const email of emailsWithUid) {
                    try {
                        await addFlags(req.client, email.uid, ['\\Trash']);
                        imapUpdates++;
                    } catch (e) {
                        console.warn(`⚠️ Could not update IMAP flags for UID ${email.uid}:`, e.message);
                    }
                }

                res.json({
                    ok: true,
                    message: 'Emails moved to trash',
                    data: {
                        database: { modified: result.modifiedCount },
                        imap: { updated: imapUpdates },
                        totalEmails: emailIdsToProcess.length
                    }
                });
            }

        } catch (error) {
            console.error('❌ Email DELETE failed:', error.message);
            res.status(500).json({
                ok: false,
                message: 'Failed to delete emails',
                error: error.message
            });
        }
    }));

// ============================================================================
// SUPPORTING ENDPOINTS
// ============================================================================

// GET: Search emails (enhanced search)
router.get('/search', validateClient, wrapRoute(async (req, res) => {
    try {
        const { 
            q: query, 
            page = 1, 
            limit = 50,
            field = 'all' // 'all', 'subject', 'from', 'to', 'body' - CHANGED from 'in' to 'field'
        } = req.query;

        if (!query) {
            return res.status(400).json({
                ok: false,
                message: 'Search query (q) is required'
            });
        }

        const skip = (page - 1) * limit;
        
        // Build search query
        const searchConditions = { clientID: req.client.clientID };
        
        if (field === 'all' || !field) { // CHANGED from 'in' to 'field'
            searchConditions.$or = [
                { subject: { $regex: query, $options: 'i' } },
                { from: { $regex: query, $options: 'i' } },
                { to: { $regex: query, $options: 'i' } },
                { text: { $regex: query, $options: 'i' } },
                { html: { $regex: query, $options: 'i' } }
            ];
        } else {
            searchConditions[field] = { $regex: query, $options: 'i' }; // CHANGED from 'in' to 'field'
        }

        // Execute search
        const [messages, total] = await Promise.all([
            Email.find(searchConditions)
                .sort({ date: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .lean(),
            Email.countDocuments(searchConditions)
        ]);

        // Group by thread for better presentation
        const threadMap = new Map();
        messages.forEach(message => {
            const threadId = message.threadId;
            if (!threadMap.has(threadId)) {
                threadMap.set(threadId, {
                    threadId,
                    subject: message.subject.replace(/^Re:\s*/i, ''),
                    messages: [],
                    participants: new Set(),
                    lastDate: message.date,
                    messageCount: 0,
                    hasAttachments: false
                });
            }
            
            const thread = threadMap.get(threadId);
            thread.messages.push(message);
            thread.messageCount++;
            thread.participants.add(message.from);
            thread.participants.add(message.to);
            
            if (message.attachments?.length > 0) {
                thread.hasAttachments = true;
            }
            
            if (message.date > thread.lastDate) {
                thread.lastDate = message.date;
            }
        });

        const threads = Array.from(threadMap.values())
            .map(thread => ({
                ...thread,
                participants: Array.from(thread.participants).filter(p => p),
                snippet: thread.messages[0]?.text?.substring(0, 150) || ''
            }))
            .sort((a, b) => b.lastDate - a.lastDate);

        res.json({
            ok: true,
            data: {
                query,
                field, // CHANGED from 'in' to 'field'
                messages: {
                    data: messages,
                    total,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    pages: Math.ceil(total / limit)
                },
                threads: {
                    data: threads,
                    total: threads.length
                },
                totalResults: total
            },
            clientID: req.client.clientID,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Search failed:', error.message);
        res.status(500).json({
            ok: false,
            message: 'Search failed',
            error: error.message
        });
    }
}));


// GET: Email statistics
router.get('/stats', validateClient, wrapRoute(async (req, res) => {
    try {
        const stats = await Email.aggregate([
            { $match: { clientID: req.client.clientID } },
            {
                $group: {
                    _id: null,
                    totalThreads: { $addToSet: '$threadId' },
                    totalMessages: { $sum: 1 },
                    unreadMessages: {
                        $sum: {
                            $cond: [
                                { $in: ['\\Seen', '$flags'] },
                                0,
                                1
                            ]
                        }
                    },
                    inboundMessages: {
                        $sum: {
                            $cond: [
                                { $eq: ['$direction', 'inbound'] },
                                1,
                                0
                            ]
                        }
                    },
                    outboundMessages: {
                        $sum: {
                            $cond: [
                                { $eq: ['$direction', 'outbound'] },
                                1,
                                0
                            ]
                        }
                    },
                    withAttachments: {
                        $sum: {
                            $cond: [
                                { $gt: [{ $size: '$attachments' }, 0] },
                                1,
                                0
                            ]
                        }
                    },
                    trashedMessages: {
                        $sum: {
                            $cond: [
                                { $in: ['\\Trash', '$flags'] },
                                1,
                                0
                            ]
                        }
                    },
                    spamMessages: {
                        $sum: {
                            $cond: [
                                { $in: ['\\Spam', '$flags'] },
                                1,
                                0
                            ]
                        }
                    }
                }
            },
            {
                $project: {
                    _id: 0,
                    totalThreads: { $size: '$totalThreads' },
                    totalMessages: 1,
                    unreadMessages: 1,
                    inboundMessages: 1,
                    outboundMessages: 1,
                    withAttachments: 1,
                    trashedMessages: 1,
                    spamMessages: 1,
                    readMessages: { $subtract: ['$totalMessages', '$unreadMessages'] }
                }
            }
        ]);

        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const recentActivity = await Email.aggregate([
            {
                $match: {
                    clientID: req.client.clientID,
                    date: { $gte: thirtyDaysAgo }
                }
            },
            {
                $group: {
                    _id: {
                        $dateToString: { format: "%Y-%m-%d", date: "$date" }
                    },
                    count: { $sum: 1 }
                }
            },
            { $sort: { _id: 1 } },
            { $limit: 30 }
        ]);

        res.json({
            ok: true,
            data: {
                summary: stats[0] || {
                    totalThreads: 0,
                    totalMessages: 0,
                    unreadMessages: 0,
                    inboundMessages: 0,
                    outboundMessages: 0,
                    withAttachments: 0,
                    trashedMessages: 0,
                    spamMessages: 0,
                    readMessages: 0
                },
                recentActivity,
                timestamp: new Date().toISOString()
            },
            clientID: req.client.clientID
        });

    } catch (error) {
        console.error('❌ Stats fetch failed:', error.message);
        res.status(500).json({
            ok: false,
            message: 'Failed to fetch statistics',
            error: error.message
        });
    }
}));

// POST: Bulk operations
router.post('/batch', validateClient, wrapRoute(async (req, res) => {
    try {
        const { operations = [] } = req.body;

        if (!Array.isArray(operations) || operations.length === 0) {
            return res.status(400).json({
                ok: false,
                message: 'Operations array is required'
            });
        }

        const results = [];
        const errors = [];

        for (const op of operations) {
            try {
                let result;
                
                switch (op.action) {
                    case 'markRead':
                        result = await Email.updateMany(
                            {
                                _id: { $in: op.ids },
                                clientID: req.client.clientID
                            },
                            { $addToSet: { flags: '\\Seen' } }
                        );
                        break;
                        
                    case 'markUnread':
                        result = await Email.updateMany(
                            {
                                _id: { $in: op.ids },
                                clientID: req.client.clientID
                            },
                            { $pull: { flags: '\\Seen' } }
                        );
                        break;
                        
                    case 'addLabel':
                        result = await Email.updateMany(
                            {
                                _id: { $in: op.ids },
                                clientID: req.client.clientID
                            },
                            { $addToSet: { flags: { $each: op.labels || [op.label] } } }
                        );
                        break;
                        
                    case 'removeLabel':
                        result = await Email.updateMany(
                            {
                                _id: { $in: op.ids },
                                clientID: req.client.clientID
                            },
                            { $pull: { flags: { $in: op.labels || [op.label] } } }
                        );
                        break;
                        
                    case 'trash':
                        result = await Email.updateMany(
                            {
                                _id: { $in: op.ids },
                                clientID: req.client.clientID
                            },
                            { $addToSet: { flags: '\\Trash' } }
                        );
                        break;
                        
                    default:
                        throw new Error(`Unknown action: ${op.action}`);
                }
                
                results.push({
                    action: op.action,
                    ids: op.ids,
                    modifiedCount: result.modifiedCount,
                    success: true
                });
                
            } catch (error) {
                errors.push({
                    action: op.action,
                    ids: op.ids,
                    error: error.message,
                    success: false
                });
                console.error(`❌ Batch operation failed for action ${op.action}:`, error.message);
            }
        }

        res.json({
            ok: true,
            data: {
                results,
                errors,
                totalOperations: operations.length,
                successful: results.length,
                failed: errors.length
            },
            clientID: req.client.clientID,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Batch operations failed:', error.message);
        res.status(500).json({
            ok: false,
            message: 'Batch operations failed',
            error: error.message
        });
    }
}));

// ============================================================================
// NEWSLETTER ROUTES
// ============================================================================

// SEND NEWSLETTER TO SUBSCRIBERS
router.post('/newsletter/send', validateClient, upload.array('attachments', 5), wrapRoute(async (req, res) => {
    const { 
        subject, 
        text, 
        html, 
        useSubscribers = true,
        customRecipients = [],
        segment = 'all'
    } = req.body;

    const attachments = (req.files || []).map(file => ({
        filename: file.originalname,
        content: file.buffer
    }));

    // Validate required fields
    if (!subject || !html) {
        return res.status(400).json({ 
            ok: false, 
            message: 'Missing required fields: subject, html' 
        });
    }

    try {
        const newsletterData = {
            subject,
            text: text || html.replace(/<[^>]*>/g, '').substring(0, 500),
            html,
            attachments
        };

        const options = {
            useSubscribers: useSubscribers !== false,
            customRecipients: customRecipients || [],
            segment
        };

        // Get subscriber count for response
        const subscriberCount = await NewsletterService.getSubscriberCount(req.client.clientID);

        // Send immediate response
        const rateLimit = NewsletterService.checkRateLimit(req.client.clientID);
        const totalBatches = Math.ceil(subscriberCount / 50);

        res.json({
            ok: true,
            message: 'Newsletter sending started',
            data: {
                recipientSource: useSubscribers ? 'subscribers' : 'custom',
                totalSubscribers: subscriberCount,
                totalBatches,
                estimatedTime: `${Math.ceil((totalBatches * 1000) / 1000 / 60)} minutes`,
                rateLimit: {
                    currentHour: rateLimit.hourly,
                    currentDay: rateLimit.daily
                }
            }
        });

        // Process in background
        (async () => {
            try {
                const results = await NewsletterService.sendNewsletter(
                    req.client, 
                    newsletterData,
                    options
                );

                console.log(`✅ Newsletter completed:`, results);
                
            } catch (error) {
                console.error('💥 Newsletter processing failed:', error);
            }
        })();

    } catch (error) {
        console.error('❌ Newsletter setup failed:', error);
        res.status(400).json({ 
            ok: false, 
            message: error.message 
        });
    }
}));

// GET SUBSCRIBERS LIST
router.get('/newsletter/subscribers', validateClient, wrapRoute(async (req, res) => {
    try {
        const { page = 1, limit = 50, activeOnly = true } = req.query;
        const skip = (page - 1) * limit;

        const subscribers = await NewsletterService.getSubscribers(req.client.clientID, {
            skip: parseInt(skip),
            limit: parseInt(limit),
            activeOnly: activeOnly !== 'false'
        });

        const total = await NewsletterService.getSubscriberCount(req.client.clientID, activeOnly !== 'false');

        res.json({
            ok: true,
            data: {
                subscribers,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / limit)
                }
            }
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            message: 'Failed to fetch subscribers',
            error: error.message
        });
    }
}));

// ADD SUBSCRIBERS IN BULK
router.post('/newsletter/subscribers/bulk', validateClient, wrapRoute(async (req, res) => {
    try {
        const { subscribers } = req.body;

        if (!Array.isArray(subscribers) || subscribers.length === 0) {
            return res.status(400).json({
                ok: false,
                message: 'Subscribers array is required and cannot be empty'
            });
        }

        const result = await NewsletterService.addSubscribers(req.client.clientID, subscribers);

        res.json({
            ok: true,
            data: result
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            message: 'Failed to add subscribers',
            error: error.message
        });
    }
}));

// UNSUBSCRIBE EMAILS
router.post('/newsletter/subscribers/unsubscribe', validateClient, wrapRoute(async (req, res) => {
    try {
        const { emails } = req.body;

        if (!Array.isArray(emails) || emails.length === 0) {
            return res.status(400).json({
                ok: false,
                message: 'Emails array is required and cannot be empty'
            });
        }

        const result = await NewsletterService.unsubscribeEmails(req.client.clientID, emails);

        res.json({
            ok: true,
            data: result
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            message: 'Failed to unsubscribe emails',
            error: error.message
        });
    }
}));

// GET SUBSCRIBER STATISTICS
router.get('/newsletter/subscribers/stats', validateClient, wrapRoute(async (req, res) => {
    try {
        const totalSubscribers = await NewsletterService.getSubscriberCount(req.client.clientID, false);
        const activeSubscribers = await NewsletterService.getSubscriberCount(req.client.clientID, true);

        // Get subscription growth (last 30 days)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const recentSubscribers = await EmailSubscriber.countDocuments({
            clientID: req.client.clientID,
            dateSubscribed: { $gte: thirtyDaysAgo }
        });

        res.json({
            ok: true,
            data: {
                total: totalSubscribers,
                active: activeSubscribers,
                inactive: totalSubscribers - activeSubscribers,
                recent: recentSubscribers,
                activeRate: totalSubscribers > 0 ? ((activeSubscribers / totalSubscribers) * 100).toFixed(1) : 0
            }
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            message: 'Failed to get subscriber statistics',
            error: error.message
        });
    }
}));

// GET RATE LIMIT STATUS
router.get('/newsletter/rate-limit', validateClient, wrapRoute(async (req, res) => {
    try {
        const rateLimit = NewsletterService.getRateLimitStatus(req.client.clientID);
        
        res.json({
            ok: true,
            limits: rateLimit
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            message: 'Failed to get rate limit status',
            error: error.message
        });
    }
}));

// GET NEWSLETTER STATISTICS
router.get('/newsletter/stats', validateClient, wrapRoute(async (req, res) => {
    try {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const stats = await Email.aggregate([
            {
                $match: {
                    clientID: req.client.clientID,
                    direction: 'outbound',
                    isNewsletter: true,
                    date: { $gte: thirtyDaysAgo }
                }
            },
            {
                $group: {
                    _id: {
                        $dateToString: { format: "%Y-%m-%d", date: "$date" }
                    },
                    count: { $sum: 1 }
                }
            },
            { $sort: { _id: 1 } }
        ]);

        const totalNewsletters = await Email.countDocuments({
            clientID: req.client.clientID,
            isNewsletter: true
        });

        // Get total emails sent via newsletter
        const totalNewsletterEmails = await Email.countDocuments({
            clientID: req.client.clientID,
            direction: 'outbound',
            isNewsletter: true
        });

        res.json({ 
            ok: true, 
            data: {
                stats,
                totalNewsletters,
                totalNewsletterEmails
            }
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            message: 'Failed to get newsletter statistics',
            error: error.message
        });
    }
}));

// ============================================================================
// SUBSCRIBER MANAGEMENT ROUTES
// ============================================================================

// SUBSCRIBE email (public route - no auth required)
router.post('/subscribe', wrapRoute(async (req, res) => {
    try {
        const { email, name, clientID } = req.body;

        if (!email || !clientID) {
            return res.status(400).json({ 
                ok: false, 
                message: 'Email and clientID are required' 
            });
        }

        // Verify client exists
        const client = await Client.findOne({ clientID });
        if (!client) {
            return res.status(404).json({ 
                ok: false, 
                message: 'Client not found' 
            });
        }

        // Subscribe email
        const subscription = new EmailSubscriber({ 
            email, 
            name: name || '', 
            clientID,
            isActive: true 
        });
        
        await subscription.save();
        
        res.status(201).json({ 
            ok: true, 
            message: 'Subscription successful',
            data: { email, name, clientID }
        });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ 
                ok: false, 
                message: 'Email already subscribed' 
            });
        }
        res.status(500).json({ 
            ok: false, 
            message: 'Subscription failed', 
            error: error.message 
        });
    }
}));

// UNSUBSCRIBE email (public route - no auth required)
router.post('/unsubscribe', wrapRoute(async (req, res) => {
    try {
        const { email, clientID } = req.body;

        if (!email || !clientID) {
            return res.status(400).json({ 
                ok: false, 
                message: 'Email and clientID are required' 
            });
        }

        const result = await EmailSubscriber.updateOne(
            { email: email.toLowerCase(), clientID }, 
            { isActive: false }
        );

        if (result.modifiedCount === 0) {
            return res.status(404).json({ 
                ok: false, 
                message: 'Email not found in subscriptions' 
            });
        }

        res.json({ 
            ok: true, 
            message: 'Unsubscribed successfully',
            data: { email, clientID }
        });
    } catch (error) {
        res.status(500).json({ 
            ok: false, 
            message: 'Unsubscribe failed', 
            error: error.message 
        });
    }
}));

// EXPORT SUBSCRIBERS TO CSV
router.get('/subscribers/export', validateClient, wrapRoute(async (req, res) => {
    try {
        const { activeOnly = true } = req.query;
        
        const subscribers = await NewsletterService.getSubscribers(
            req.client.clientID, 
            { activeOnly: activeOnly !== 'false' }
        );

        // Convert to CSV format
        const csvData = subscribers.map(sub => ({
            name: sub.name,
            email: sub.address,
            dateSubscribed: sub.dateSubscribed.toISOString().split('T')[0],
            status: sub.isActive ? 'Active' : 'Inactive'
        }));

        // Set headers for CSV download
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=subscribers-${req.client.clientID}-${Date.now()}.csv`);

        // Create CSV content
        let csvContent = 'Name,Email,Date Subscribed,Status\n';
        csvContent += csvData.map(row => 
            `"${row.name}","${row.email}","${row.dateSubscribed}","${row.status}"`
        ).join('\n');

        res.send(csvContent);

    } catch (error) {
        res.status(500).json({
            ok: false,
            message: 'Failed to export subscribers',
            error: error.message
        });
    }
}));

// ============================================================================
// HEALTH CHECK ROUTE
// ============================================================================

// HEALTH CHECK
router.get('/health', validateClient, wrapRoute(async (req, res) => {
    try {
        const emailCount = await Email.countDocuments({ clientID: req.client.clientID });
        const subscriberCount = await NewsletterService.getSubscriberCount(req.client.clientID);
        const rateLimit = NewsletterService.getRateLimitStatus(req.client.clientID);

        // Get thread count
        const threadCount = await Email.aggregate([
            { $match: { clientID: req.client.clientID } },
            { $group: { _id: '$threadId' } },
            { $count: 'total' }
        ]);

        res.json({
            ok: true,
            data: {
                client: req.client.clientID,
                emails: {
                    total: emailCount,
                    inbox: await Email.countDocuments({ 
                        clientID: req.client.clientID, 
                        direction: 'inbound' 
                    }),
                    sent: await Email.countDocuments({ 
                        clientID: req.client.clientID, 
                        direction: 'outbound' 
                    })
                },
                threads: {
                    total: threadCount[0]?.total || 0
                },
                subscribers: {
                    total: subscriberCount,
                    active: await NewsletterService.getSubscriberCount(req.client.clientID, true)
                },
                rateLimit,
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            message: 'Health check failed',
            error: error.message
        });
    }
}));


// POST: Recalculate threads for a client (fix threading issues)
router.post('/rethread', validateClient, wrapRoute(async (req, res) => {
    try {
        console.log(`🔄 Recalculating threads for client: ${req.client.clientID}`);
        
        // Get all emails for this client
        const emails = await Email.find({ clientID: req.client.clientID })
            .select('remoteId messageId inReplyTo references clientID subject threadId')
            .sort({ date: 1 })
            .lean();

        let updatedCount = 0;
        let errors = [];

        for (const email of emails) {
            try {
                // Recompute threadId using latest logic
                const newThreadId = await Email.computeThreadId({
                    messageId: email.remoteId || email.messageId,
                    inReplyTo: email.inReplyTo,
                    references: email.references,
                    clientID: email.clientID
                });

                if (newThreadId !== email.threadId) {
                    await Email.updateOne(
                        { _id: email._id },
                        { 
                            $set: { 
                                threadId: newThreadId,
                                // Also fix isThreadStarter based on inReplyTo
                                isThreadStarter: !email.inReplyTo || email.inReplyTo.trim() === ''
                            }
                        }
                    );
                    updatedCount++;
                    console.log(`✅ Updated thread for: "${email.subject}"`);
                }
            } catch (error) {
                errors.push({ emailId: email._id, error: error.message });
                console.error(`❌ Failed to update thread for: "${email.subject}"`, error);
            }
        }

        // Update thread metadata for all threads
        const uniqueThreads = [...new Set(emails.map(e => e.threadId))];
        for (const threadId of uniqueThreads) {
            await Email.updateThreadMetadata(req.client.clientID, threadId);
        }

        res.json({
            ok: true,
            message: 'Thread recalculation complete',
            data: {
                totalEmails: emails.length,
                updated: updatedCount,
                errors: errors.length,
                errorDetails: errors
            }
        });

    } catch (error) {
        console.error('❌ Re-thread failed:', error.message);
        res.status(500).json({
            ok: false,
            message: 'Failed to recalculate threads',
            error: error.message
        });
    }
}));

module.exports = router;