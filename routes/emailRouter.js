// routes/emailRouter.js
const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const Email = require('../models/Email');
const EmailSubscriber = require('../models/emailSubscriber');
const { sendMail } = require('../helpers/mailer');
const { wrapRoute } = require('../helpers/failureEmail');
const { fetchClientEmails, addFlags } = require('../helpers/imapService');
const NewsletterService = require('../helpers/newsletterService');
const Client = require('../models/client');

const router = express.Router();

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
        const threadCount = await Email.countDocuments({ 
            clientID, 
            threadId 
        });
        
        const lastMessage = await Email.findOne({ 
            clientID, 
            threadId 
        }).sort({ date: -1 });
        
        // Update all emails in the thread with current count and last message date
        await Email.updateMany(
            { clientID, threadId },
            { 
                $set: { 
                    threadCount,
                    lastMessageAt: lastMessage?.date || new Date()
                }
            }
        );
        
        // Mark the thread starter
        if (threadCount > 0) {
            const threadStarter = await Email.findOne({ 
                clientID, 
                threadId 
            }).sort({ date: 1 });
            
            if (threadStarter) {
                await Email.updateOne(
                    { _id: threadStarter._id },
                    { $set: { isThreadStarter: true } }
                );
            }
        }
    } catch (error) {
        console.error('Error updating thread metadata:', error.message);
    }
}

// -------------------- UNIFIED EMAIL FETCH ROUTE -------------------- //

// UNIFIED FETCH - Get emails, threads, and refresh from IMAP in one call
router.post('/fetch', validateClient, wrapRoute(async (req, res) => {
    try {
        const { 
            refresh = true, 
            view = 'messages', // 'messages', 'threads', or 'both'
            page = 1, 
            per = 50,
            search = '',
            threadId = ''
        } = req.body;

        console.log(`🔄 Unified fetch request:`, {
            refresh: refresh,
            view: view,
            page: page,
            per: per,
            search: search,
            threadId: threadId,
            clientID: req.client.clientID
        });

        let fetchedEmails = [];
        let refreshError = null;
        
        // Refresh emails from IMAP if requested
        if (refresh) {
            console.log('🔄 Refreshing emails from IMAP...');
            try {
                const imapEmails = await fetchClientEmails(req.client);
                fetchedEmails = Array.isArray(imapEmails) ? imapEmails : [];
                console.log(`✅ Fetched ${fetchedEmails.length} new emails from IMAP`);
            } catch (error) {
                console.error('❌ IMAP refresh failed:', error.message);
                refreshError = error.message;
                // Continue with database retrieval even if IMAP fails
            }
        }

        // Prepare response data
        const responseData = {
            ok: true,
            refresh: {
                performed: refresh,
                fetched: fetchedEmails.length,
                error: refreshError
            },
            view: view,
            clientID: req.client.clientID,
            timestamp: new Date().toISOString()
        };

        // Get messages view (individual emails)
        if (view === 'messages' || view === 'both') {
            const messagesPage = Math.max(1, Number(page));
            const messagesPer = Math.min(200, Math.max(5, Number(per)));
            const messagesSkip = (messagesPage - 1) * messagesPer;

            let messagesQuery = { clientID: req.client.clientID };
            
            // Add search filter if provided
            if (search) {
                messagesQuery.$or = [
                    { subject: { $regex: search, $options: 'i' } },
                    { from: { $regex: search, $options: 'i' } },
                    { to: { $regex: search, $options: 'i' } },
                    { text: { $regex: search, $options: 'i' } }
                ];
            }

            const totalMessages = await Email.countDocuments(messagesQuery);
            
            const messages = await Email.find(messagesQuery)
                .sort({ date: -1 })
                .skip(messagesSkip)
                .limit(messagesPer)
                .lean();

            const inboundCount = await Email.countDocuments({ 
                clientID: req.client.clientID, 
                direction: 'inbound' 
            });
            const outboundCount = await Email.countDocuments({ 
                clientID: req.client.clientID, 
                direction: 'outbound' 
            });

            responseData.messages = {
                data: messages,
                pagination: {
                    page: messagesPage,
                    per: messagesPer,
                    total: totalMessages,
                    pages: Math.ceil(totalMessages / messagesPer)
                },
                summary: {
                    total: totalMessages,
                    inbound: inboundCount,
                    outbound: outboundCount,
                    showing: messages.length
                }
            };
        }

        // Get threads view (conversations)
        if (view === 'threads' || view === 'both') {
            const threadsPage = Math.max(1, Number(page));
            const threadsPer = Math.min(50, Math.max(5, Number(per)));
            const threadsSkip = (threadsPage - 1) * threadsPer;

            // If specific thread is requested
            if (threadId) {
                const threadMessages = await Email.find({
                    clientID: req.client.clientID,
                    threadId: threadId
                }).sort({ date: 1 }).lean();

                if (threadMessages.length > 0) {
                    const participants = {
                        from: [...new Set(threadMessages.map(e => e.from))],
                        to: [...new Set(threadMessages.map(e => e.to))],
                    };

                    const threadStarter = threadMessages.find(m => m.isThreadStarter) || threadMessages[0];

                    responseData.thread = {
                        threadId,
                        subject: threadStarter.subject,
                        messageCount: threadMessages.length,
                        participants,
                        threadStarter: {
                            id: threadStarter._id,
                            subject: threadStarter.subject,
                            date: threadStarter.date
                        },
                        messages: threadMessages
                    };
                } else {
                    responseData.thread = {
                        threadId,
                        messageCount: 0,
                        messages: []
                    };
                }
            } else {
                // Get thread list with search if provided
                let threadMatch = { clientID: req.client.clientID };
                
                if (search) {
                    threadMatch.$or = [
                        { subject: { $regex: search, $options: 'i' } },
                        { from: { $regex: search, $options: 'i' } },
                        { to: { $regex: search, $options: 'i' } },
                        { text: { $regex: search, $options: 'i' } }
                    ];
                }

                const threads = await Email.aggregate([
                    { $match: threadMatch },
                    {
                        $group: {
                            _id: '$threadId',
                            threadId: { $first: '$threadId' },
                            subject: { $first: '$subject' },
                            lastMessageAt: { $max: '$date' },
                            messageCount: { $sum: 1 },
                            participants: { 
                                $addToSet: { 
                                    from: '$from',
                                    to: '$to'
                                }
                            },
                            lastMessage: { 
                                $first: {
                                    _id: '$_id',
                                    subject: '$subject',
                                    from: '$from',
                                    to: '$to',
                                    date: '$date',
                                    text: '$text',
                                    direction: '$direction',
                                    flags: '$flags'
                                }
                            }
                        }
                    },
                    { $sort: { lastMessageAt: -1 } },
                    { $skip: threadsSkip },
                    { $limit: threadsPer }
                ]);

                // Get total thread count
                const totalThreads = await Email.aggregate([
                    { $match: { clientID: req.client.clientID } },
                    { $group: { _id: '$threadId' } },
                    { $count: 'total' }
                ]);

                const total = totalThreads[0]?.total || 0;

                responseData.threads = {
                    data: threads,
                    pagination: {
                        page: threadsPage,
                        per: threadsPer,
                        total: total,
                        pages: Math.ceil(total / threadsPer)
                    }
                };
            }
        }

        // Add search results if search was performed
        if (search && (view === 'both' || view === 'search')) {
            const searchResults = await Email.aggregate([
                {
                    $match: {
                        clientID: req.client.clientID,
                        $or: [
                            { subject: { $regex: search, $options: 'i' } },
                            { from: { $regex: search, $options: 'i' } },
                            { to: { $regex: search, $options: 'i' } },
                            { text: { $regex: search, $options: 'i' } }
                        ]
                    }
                },
                {
                    $group: {
                        _id: '$threadId',
                        threadId: { $first: '$threadId' },
                        subject: { $first: '$subject' },
                        lastMessageAt: { $max: '$date' },
                        messageCount: { $sum: 1 },
                        participants: { 
                            $addToSet: { 
                                from: '$from',
                                to: '$to'
                            }
                        },
                        matchingMessages: {
                            $push: {
                                _id: '$_id',
                                subject: '$subject',
                                from: '$from',
                                to: '$to',
                                date: '$date',
                                text: '$text'
                            }
                        }
                    }
                },
                { $sort: { lastMessageAt: -1 } }
            ]);

            responseData.search = {
                query: search,
                results: searchResults,
                total: searchResults.length
            };
        }

        console.log(`✅ Unified fetch completed for client ${req.client.clientID}:`, {
            refresh: refresh,
            view: view,
            messages: responseData.messages?.data?.length || 0,
            threads: responseData.threads?.data?.length || 0,
            search: responseData.search?.total || 0
        });

        res.json(responseData);

    } catch (error) {
        console.error('❌ Unified fetch failed:', error.message);
        res.status(500).json({
            ok: false,
            message: 'Failed to fetch emails',
            error: error.message
        });
    }
}));

// -------------------- EMAIL SENDING ROUTES -------------------- //

// SEND new email with full threading support AND IMAP Sent folder
router.post('/send', validateClient, upload.array('attachments', 5), wrapRoute(async (req, res) => {
    const { to, subject, html, inReplyTo, threadId, references = [] } = req.body;
    const attachments = (req.files || []).map(file => ({
        filename: file.originalname,
        content: file.buffer
    }));

    const clientSignature = req.client.emailSignature || '';
    const finalHtml = html + `<br><br>${clientSignature}`;

    // Generate plain text fallback
    const textFallback = finalHtml
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    const domain = req.client.return_url?.replace(/^https?:\/\//, '').split('/')[0];
    const host = req.client.imapHost || `mail.${domain}`;

    console.log(`📧 Sending email with threading support via ${host}`);

    let info;
    try {
        // Determine if this is a reply or new message
        const isReply = !!(inReplyTo || threadId);
        const finalReferences = Array.isArray(references) ? references : Email.parseReferences(references);
        
        info = await sendMail({
            host: host,
            port: 587,
            secure: false,
            user: req.client.businessEmail,
            pass: req.client.businessEmailPassword,
            from: `"${req.client.companyName}" <${req.client.businessEmail}>`,
            to,
            subject: isReply && !subject.startsWith('Re:') ? `Re: ${subject}` : subject,
            text: textFallback,
            html: finalHtml,
            attachments,
            inReplyTo: inReplyTo || undefined,
            references: finalReferences,
            tls: { rejectUnauthorized: false },
            saveToSent: true // NEW: Save to IMAP Sent folder
        });
        console.log(`✅ Email sent successfully with Message-ID: ${info.messageId}`);
    } catch (error) {
        console.error('❌ SMTP failed:', error.message);
        throw new Error(`Failed to send email: ${error.message}`);
    }

    // Determine threadId
    let finalThreadId;
    if (threadId) {
        finalThreadId = threadId;
    } else if (inReplyTo) {
        // Look up the original message to get its threadId
        const original = await Email.findOne({ 
            $or: [
                { remoteId: inReplyTo, clientID: req.client.clientID },
                { _id: inReplyTo, clientID: req.client.clientID }
            ]
        });
        finalThreadId = original?.threadId || inReplyTo;
    } else {
        // New conversation - threadId is the messageId
        finalThreadId = info.messageId;
    }

    const emailData = {
        remoteId: info.messageId,
        from: req.client.businessEmail,
        to: to,
        subject,
        text: textFallback,
        html: finalHtml,
        date: new Date(),
        flags: ['\\Seen'],
        direction: 'outbound',
        clientID: req.client.clientID,
        threadId: finalThreadId,
        inReplyTo: inReplyTo || undefined,
        references: finalReferences,
        isThreadStarter: !inReplyTo, // Only thread starter if not a reply
        threadCount: 1,
        lastMessageAt: new Date(),
        // Add IMAP sent folder info
        imapSaved: true,
        imapFolder: 'Sent'
    };

    console.log('📝 Saving sent email with threading:', {
        remoteId: info.messageId,
        threadId: finalThreadId,
        isReply: !!inReplyTo,
        isThreadStarter: !inReplyTo,
        imapSaved: true
    });

    let doc;
    try {
        // For sent emails, don't include uid at all
        doc = await Email.create(emailData);
        console.log(`✅ Sent email saved to database: ${doc._id}`);
    } catch (createError) {
        if (createError.code === 11000) {
            console.log('🔄 Duplicate key detected, using upsert...');
            doc = await Email.findOneAndUpdate(
                { 
                    remoteId: info.messageId, 
                    clientID: req.client.clientID 
                },
                emailData,
                { 
                    upsert: true, 
                    new: true,
                    setDefaultsOnInsert: true 
                }
            );
            console.log(`✅ Sent email saved via upsert: ${doc._id}`);
        } else {
            throw createError;
        }
    }

    // Update thread metadata
    await updateThreadMetadata(req.client.clientID, finalThreadId);

    res.json({ 
        ok: true, 
        message: 'Email sent successfully and saved to Sent folder',
        data: {
            messageId: info.messageId,
            threadId: finalThreadId,
            to: to,
            subject,
            timestamp: new Date().toISOString(),
            emailId: doc._id,
            isThreadStarter: !inReplyTo,
            savedToSentFolder: true // NEW: Confirm sent folder save
        }
    });
}));

// SEND new email with full threading support AND IMAP Sent folder
router.post('/send', validateClient, upload.array('attachments', 5), wrapRoute(async (req, res) => {
    // Add delay to prevent SMTP connection limits
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    await delay(1000);

    const { to, subject, html, inReplyTo, threadId, references = [] } = req.body;
    const attachments = (req.files || []).map(file => ({
        filename: file.originalname,
        content: file.buffer
    }));

    const clientSignature = req.client.emailSignature || '';
    const finalHtml = html + `<br><br>${clientSignature}`;

    // Generate plain text fallback
    const textFallback = finalHtml
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    const domain = req.client.return_url?.replace(/^https?:\/\//, '').split('/')[0];
    const host = req.client.imapHost || `mail.${domain}`;

    console.log(`📧 Sending email with threading support via ${host}`, {
        to,
        subject,
        hasHtml: !!html,
        hasText: !!textFallback,
        attachments: attachments.length
    });

    let info;
    try {
        // Determine if this is a reply or new message
        const isReply = !!(inReplyTo || threadId);
        const finalReferences = Array.isArray(references) ? references : Email.parseReferences(references);
        
        // Use sendMailWithRetry to handle connection limits
        info = await sendMailWithRetry({
            host: host,
            port: 587,
            secure: false,
            user: req.client.businessEmail,
            pass: req.client.businessEmailPassword,
            from: `"${req.client.companyName}" <${req.client.businessEmail}>`,
            to,
            subject: isReply && !subject.startsWith('Re:') ? `Re: ${subject}` : subject,
            text: textFallback,
            html: finalHtml,
            attachments,
            inReplyTo: inReplyTo || undefined,
            references: finalReferences,
            tls: { rejectUnauthorized: false },
            saveToSent: true
        }, 3); // 3 retries
        console.log(`✅ Email sent successfully with Message-ID: ${info.messageId}`);
    } catch (error) {
        console.error('❌ SMTP failed after retries:', error.message);
        return res.status(500).json({
            ok: false,
            message: 'Failed to send email due to server limits. Please try again in a moment.',
            error: error.message
        });
    }

    // Determine threadId
    let finalThreadId;
    if (threadId) {
        finalThreadId = threadId;
    } else if (inReplyTo) {
        // Look up the original message to get its threadId
        const original = await Email.findOne({ 
            $or: [
                { remoteId: inReplyTo, clientID: req.client.clientID },
                { _id: inReplyTo, clientID: req.client.clientID }
            ]
        });
        finalThreadId = original?.threadId || inReplyTo;
    } else {
        // New conversation - threadId is the messageId
        finalThreadId = info.messageId;
    }

    const emailData = {
        remoteId: info.messageId,
        from: req.client.businessEmail,
        to: to,
        subject,
        text: textFallback,
        html: finalHtml,
        date: new Date(),
        flags: ['\\Seen'],
        direction: 'outbound',
        clientID: req.client.clientID,
        threadId: finalThreadId,
        inReplyTo: inReplyTo || undefined,
        references: finalReferences,
        isThreadStarter: !inReplyTo, // Only thread starter if not a reply
        threadCount: 1,
        lastMessageAt: new Date(),
        // Add IMAP sent folder info
        imapSaved: true,
        imapFolder: 'Sent'
    };

    console.log('📝 Saving sent email with threading:', {
        remoteId: info.messageId,
        threadId: finalThreadId,
        isReply: !!inReplyTo,
        isThreadStarter: !inReplyTo,
        imapSaved: true
    });

    let doc;
    try {
        // For sent emails, don't include uid at all
        doc = await Email.create(emailData);
        console.log(`✅ Sent email saved to database: ${doc._id}`);
    } catch (createError) {
        if (createError.code === 11000) {
            console.log('🔄 Duplicate key detected, using upsert...');
            doc = await Email.findOneAndUpdate(
                { 
                    remoteId: info.messageId, 
                    clientID: req.client.clientID 
                },
                emailData,
                { 
                    upsert: true, 
                    new: true,
                    setDefaultsOnInsert: true 
                }
            );
            console.log(`✅ Sent email saved via upsert: ${doc._id}`);
        } else {
            console.error('❌ Database save error:', createError);
            // Don't fail the entire request if DB save fails
            doc = { _id: 'temp_id' };
        }
    }

    // Update thread metadata
    try {
        await updateThreadMetadata(req.client.clientID, finalThreadId);
        console.log(`✅ Thread metadata updated for: ${finalThreadId}`);
    } catch (threadError) {
        console.warn('⚠️ Thread metadata update failed:', threadError.message);
    }

    res.json({ 
        ok: true, 
        message: 'Email sent successfully and saved to Sent folder',
        data: {
            messageId: info.messageId,
            threadId: finalThreadId,
            to: to,
            subject,
            timestamp: new Date().toISOString(),
            emailId: doc._id,
            isThreadStarter: !inReplyTo,
            savedToSentFolder: true
        }
    });
}));

// ENHANCED REPLY with full threading support AND IMAP Sent folder
router.post('/reply', validateClient, upload.array('attachments', 5), wrapRoute(async (req, res) => {
    // Add delay to prevent SMTP connection limits
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    await delay(1000);

    const { uid, html, threadId, emailId } = req.body;
    
    try {
        // Find original email using multiple strategies
        let original;
        
        if (emailId) {
            original = await Email.findOne({ 
                _id: emailId, 
                clientID: req.client.clientID 
            });
        }
        
        if (!original && uid) {
            original = await Email.findOne({ 
                uid: uid, 
                clientID: req.client.clientID 
            });
        }
        
        if (!original && threadId) {
            original = await Email.findOne({ 
                threadId: threadId, 
                clientID: req.client.clientID 
            }).sort({ date: -1 });
        }
        
        if (!original) {
            return res.status(404).json({ 
                ok: false, 
                message: 'Original email not found' 
            });
        }

        console.log('📧 Replying to email with threading:', {
            originalId: original._id,
            originalSubject: original.subject,
            originalThreadId: original.threadId,
            originalRemoteId: original.remoteId
        });

        const subject = original.subject.startsWith('Re:') ? original.subject : `Re: ${original.subject}`;
        const attachments = (req.files || []).map(file => ({
            filename: file.originalname,
            content: file.buffer
        }));

        const clientSignature = req.client.emailSignature || '';
        const finalHtml = html + `<br><br>${clientSignature}`;

        // Generate plain text fallback
        const textFallback = finalHtml
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]*>/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        const domain = req.client.return_url?.replace(/^https?:\/\//, '').split('/')[0];
        const host = req.client.imapHost || `mail.${domain}`;
        
        // Build references array for threading
        const references = [...(original.references || []), original.remoteId].filter(Boolean);

        console.log('📧 Preparing reply with content:', {
            to: original.from,
            subject,
            hasHtml: !!finalHtml,
            hasText: !!textFallback,
            referencesCount: references.length,
            attachments: attachments.length
        });

        let info;
        try {
            // Use sendMailWithRetry to handle connection limits
            info = await sendMailWithRetry({
                host: host,
                port: 587,
                secure: false,
                user: req.client.businessEmail,
                pass: req.client.businessEmailPassword,
                from: `"${req.client.companyName}" <${req.client.businessEmail}>`,
                to: original.from,
                subject,
                text: textFallback,
                html: finalHtml,
                attachments,
                inReplyTo: original.remoteId,
                references: references,
                tls: { rejectUnauthorized: false },
                saveToSent: true
            }, 3); // 3 retries
            console.log(`✅ Reply sent successfully with threading headers and saved to Sent folder`);
        } catch (error) {
            console.error('❌ SMTP failed after retries:', error.message);
            return res.status(500).json({ 
                ok: false, 
                message: 'Failed to send reply due to server limits. Please try again in a moment.',
                error: error.message
            });
        }

        // Use the original thread ID
        const replyThreadId = original.threadId || original.remoteId;

        const emailData = {
            remoteId: info.messageId,
            from: req.client.businessEmail,
            to: original.from,
            subject,
            text: textFallback,
            html: finalHtml,
            date: new Date(),
            flags: ['\\Seen'],
            direction: 'outbound',
            clientID: req.client.clientID,
            threadId: replyThreadId,
            inReplyTo: original.remoteId,
            references: references,
            isThreadStarter: false,
            // Add IMAP sent folder info
            imapSaved: true,
            imapFolder: 'Sent'
        };

        console.log('📝 Saving reply with threading:', {
            remoteId: info.messageId,
            threadId: replyThreadId,
            inReplyTo: original.remoteId,
            referencesCount: references.length,
            imapSaved: true
        });

        let doc;
        try {
            // Remove uid for sent emails
            const { uid, ...emailDataWithoutUid } = emailData;
            doc = await Email.create(emailDataWithoutUid);
            console.log(`✅ Reply saved to database: ${doc._id}`);
        } catch (createError) {
            if (createError.code === 11000) {
                console.log('🔄 Duplicate key, using upsert...');
                const { uid, ...emailDataWithoutUid } = emailData;
                doc = await Email.findOneAndUpdate(
                    { 
                        remoteId: info.messageId, 
                        clientID: req.client.clientID 
                    },
                    emailDataWithoutUid,
                    { 
                        upsert: true, 
                        new: true,
                        setDefaultsOnInsert: true 
                    }
                );
                console.log(`✅ Reply saved via upsert: ${doc._id}`);
            } else {
                console.error('❌ Database save error:', createError);
                // Don't fail the entire request if DB save fails
                doc = { _id: 'temp_id' };
            }
        }

        // Update thread metadata
        try {
            await updateThreadMetadata(req.client.clientID, replyThreadId);
            console.log(`✅ Thread metadata updated for: ${replyThreadId}`);
        } catch (threadError) {
            console.warn('⚠️ Thread metadata update failed:', threadError.message);
        }

        // Mark original as answered in IMAP if we have UID
        if (original.uid && original.uid !== 'null' && original.uid !== null) {
            try {
                await addFlags(req.client, original.uid, ['\\Answered', '\\Seen']);
                console.log('✅ Original email marked as answered in IMAP');
            } catch (e) {
                console.warn('⚠️ Failed to mark original email as answered:', e.message);
            }
        }

        res.json({ 
            ok: true, 
            message: 'Reply sent successfully and saved to Sent folder',
            data: {
                messageId: info.messageId,
                threadId: replyThreadId,
                to: original.from,
                subject,
                timestamp: new Date().toISOString(),
                emailId: doc._id,
                savedToSentFolder: true
            }
        });
        
    } catch (error) {
        console.error('❌ Email reply failed:', error.message);
        res.status(500).json({ 
            ok: false, 
            message: 'Failed to send reply',
            error: error.message
        });
    }
}));

// Add this retry function to your mailer.js or in the same file
async function sendMailWithRetry(options, maxRetries = 3) {
    const { sendMail } = require('../helpers/mailer');
    
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

// ENHANCED THREADS ENDPOINT
router.get('/threads', validateClient, wrapRoute(async (req, res) => {
    try {
        const { page = 1, limit = 50, search = '' } = req.query;
        const skip = (page - 1) * limit;

        let matchStage = { clientID: req.client.clientID };
        
        if (search) {
            matchStage.$or = [
                { subject: { $regex: search, $options: 'i' } },
                { from: { $regex: search, $options: 'i' } },
                { to: { $regex: search, $options: 'i' } },
                { text: { $regex: search, $options: 'i' } }
            ];
        }

        const threads = await Email.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: '$threadId',
                    threadId: { $first: '$threadId' },
                    subject: { 
                        $first: {
                            $cond: [
                                { $eq: ['$isThreadStarter', true] },
                                '$subject',
                                { $arrayElemAt: [{ $split: ['$subject', 'Re: '] }, -1] }
                            ]
                        }
                    },
                    lastMessageAt: { $max: '$date' },
                    messageCount: { $sum: 1 },
                    participants: { 
                        $addToSet: { 
                            from: '$from',
                            to: '$to'
                        }
                    },
                    threadStarter: {
                        $first: {
                            $cond: [
                                { $eq: ['$isThreadStarter', true] },
                                {
                                    _id: '$_id',
                                    subject: '$subject',
                                    from: '$from',
                                    date: '$date'
                                },
                                null
                            ]
                        }
                    },
                    lastMessage: { 
                        $first: {
                            _id: '$_id',
                            subject: '$subject',
                            from: '$from',
                            to: '$to',
                            date: '$date',
                            text: { $substr: ['$text', 0, 100] },
                            direction: '$direction',
                            flags: '$flags'
                        }
                    }
                }
            },
            { $sort: { lastMessageAt: -1 } },
            { $skip: skip },
            { $limit: parseInt(limit) }
        ]);

        // Get total thread count
        const totalThreads = await Email.aggregate([
            { $match: { clientID: req.client.clientID } },
            { $group: { _id: '$threadId' } },
            { $count: 'total' }
        ]);

        const total = totalThreads[0]?.total || 0;

        res.json({
            ok: true,
            data: {
                threads,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / limit)
                }
            }
        });
    } catch (error) {
        console.error('❌ Threads fetch failed:', error.message);
        res.status(500).json({
            ok: false,
            message: 'Failed to fetch threads',
            error: error.message
        });
    }
}));

// -------------------- NEWSLETTER ROUTES -------------------- //

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

// -------------------- SUBSCRIBER MANAGEMENT ROUTES -------------------- //

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

// -------------------- HEALTH CHECK ROUTE -------------------- //

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

module.exports = router;