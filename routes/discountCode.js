const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Order } = require('../models/order');
const { OrderItem } = require('../models/orderItem');
const Customer = require('../models/customer');
const DiscountCode = require('../models/discountCode');
const Product = require('../models/product');
const Client = require('../models/client');
const WishList = require('../models/wishList');
const NewsletterService = require('../helpers/newsletterService');
const { escapeHtml } = require('../helpers/signatureHtml');
const { resolveSmtpHost, resolveSmtpPort, resolveSmtpSecure } = require('../helpers/mailHost');
const { sendMail } = require('../helpers/mailer');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');

// Middleware to authenticate JWT token and extract clientId
const authenticateToken = (req, res, next) => {
  const token = req.headers.authorization;
  if (!token || !token.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });

  const tokenValue = token.split(' ')[1];
  try {
    const { decoded } = verifyJwtWithAnySecret(jwt, tokenValue);
    req.clientId = decoded.clientID;
    next();
  } catch (_err) {
    return res.status(403).json({ error: 'Forbidden - Invalid token' });
  }
};

async function sendWishlistCheckoutCodeAlerts({
  clientId,
  code,
  discount,
  appliesTo = [],
  type = 'all',
}) {
  const productIds = Array.isArray(appliesTo)
    ? appliesTo.map((id) => String(id)).filter(Boolean)
    : [];
  if (!productIds.length) return { status: 'skipped', reason: 'no_products' };
  if (!['all', 'product', 'category'].includes(String(type || 'all').toLowerCase())) {
    return { status: 'skipped', reason: 'type_not_product_like' };
  }

  const [clientDoc, lists, products] = await Promise.all([
    Client.findOne({ clientID: clientId }),
    WishList.find({
      clientID: clientId,
      items: { $elemMatch: { product: { $in: productIds }, notifyOnSale: true } },
    }).lean(),
    Product.find({ _id: { $in: productIds }, clientID: clientId })
      .select('productName')
      .lean(),
  ]);

  if (!clientDoc) return { status: 'skipped', reason: 'client_not_found' };

  const host = resolveSmtpHost(clientDoc);
  const port = resolveSmtpPort(clientDoc, host);
  if (!host) return { status: 'skipped', reason: 'smtp_not_configured' };
  if (!lists.length) return { status: 'skipped', reason: 'no_matching_wishlist_items' };

  const productNameById = new Map(products.map((p) => [String(p._id), p.productName || 'Product']));
  const byCustomer = new Map();

  for (const list of lists) {
    const cid = String(list.customerID);
    if (!byCustomer.has(cid)) byCustomer.set(cid, { productNames: new Set(), listNames: new Set() });
    const bucket = byCustomer.get(cid);
    bucket.listNames.add(String(list.name || 'Wish list'));
    for (const item of list.items || []) {
      const pid = String(item.product || '');
      if (!productNameById.has(pid)) continue;
      if (item.notifyOnSale !== true) continue;
      bucket.productNames.add(productNameById.get(pid));
    }
  }

  const customers = await Customer.find({
    _id: { $in: Array.from(byCustomer.keys()) },
    clientID: clientId,
  }).lean();

  let sent = 0;
  for (const customer of customers) {
    const bucket = byCustomer.get(String(customer._id));
    if (!bucket || !bucket.productNames.size || !customer.emailAddress) continue;
    const productList = Array.from(bucket.productNames).slice(0, 8);
    const listItemsHtml = productList
      .map(
        (n) =>
          `<li style="margin: 8px 0; padding: 8px 10px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;">${escapeHtml(
            String(n)
          )}</li>`
      )
      .join('');
    const firstName = escapeHtml(String(customer.customerFirstName || 'there'));
    const company = escapeHtml(String(clientDoc.companyName || 'Our store'));
    const websiteUrl = clientDoc.return_url ? String(clientDoc.return_url).replace(/\/$/, '') : '';
    const html = `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 640px; margin: 0 auto; color: #111827; background: #ffffff;">
        <div style="background: linear-gradient(135deg, #111827, #374151); color: #fff; padding: 24px; border-radius: 12px 12px 0 0;">
          <h2 style="margin: 0; font-size: 24px;">${company}</h2>
          <p style="margin: 8px 0 0; opacity: 0.95;">Wish list match found</p>
        </div>
        <div style="padding: 22px; border: 1px solid #e5e7eb; border-top: 0; border-radius: 0 0 12px 12px;">
          <p style="margin-top: 0;">Hi ${firstName},</p>
          <p>Good news - a new discount code now applies to item(s) on your wish list:</p>
          <ul style="list-style: none; padding: 0; margin: 14px 0 16px;">${listItemsHtml}</ul>
          <div style="margin: 16px 0; padding: 14px; background: #f3f4f6; border-radius: 10px; border: 1px solid #e5e7eb;">
            <p style="margin: 6px 0;"><strong>Code:</strong> ${escapeHtml(String(code))}</p>
            <p style="margin: 6px 0;"><strong>Discount:</strong> ${escapeHtml(String(discount))}% off</p>
          </div>
          ${
            websiteUrl
              ? `<p style="margin: 22px 0 10px;">
                  <a href="${escapeHtml(
                    websiteUrl
                  )}" style="display: inline-block; background: #111827; color: #fff; text-decoration: none; padding: 12px 18px; border-radius: 8px; font-weight: 600;">Visit website</a>
                </p>`
              : ''
          }
          <p style="font-size: 12px; color: #6b7280; margin-bottom: 0;">You are receiving this because sale alerts are enabled for your wish list items.</p>
        </div>
      </div>`;
    const text = `Hi ${customer.customerFirstName || 'there'},

A new discount code matches item(s) in your wish list.
Code: ${code}
Discount: ${discount}% off
${websiteUrl ? `Website: ${websiteUrl}` : ''}`;

    try {
      await sendMail({
        host,
        port,
        secure: resolveSmtpSecure(port),
        user: clientDoc.businessEmail,
        pass: clientDoc.businessEmailPassword,
        from: `"${clientDoc.companyName}" <${clientDoc.businessEmail}>`,
        to: customer.emailAddress,
        subject: `Wish list match: ${code} (${discount}% off)`,
        text,
        html,
      });
      sent += 1;
    } catch (e) {
      console.error('wishlist checkout-code alert failed:', e.message);
    }
  }

  return { status: 'done', targetedCustomers: byCustomer.size, sent };
}

// --------------------
// VERIFY DISCOUNT CODE
// --------------------
router.post('/verify-discount-code', authenticateToken, async (req, res) => {
  const { discountCode, cartProductIds } = req.body;
  if (!discountCode || !Array.isArray(cartProductIds) || cartProductIds.length === 0) {
    return res.status(400).json({ error: 'Invalid discount code or cart is empty' });
  }

  try {
    const discount = await DiscountCode.findOne({ code: discountCode, clientID: req.clientId });
    if (!discount) return res.status(404).json({ error: 'Discount code not found for this client' });
    if (discount.usageCount >= discount.usageLimit) return res.status(400).json({ error: 'Discount code unavailable' });

    const eligibleProducts = [];
    let totalDiscount = 0;

    for (const productId of cartProductIds) {
      const product = await Product.findById(productId);
      if (product && discount.appliesTo.some(id => id.toString() === product._id.toString())) {
        eligibleProducts.push(product);
        totalDiscount += (product.price * discount.discount) / 100;
      }
    }

    if (eligibleProducts.length === 0) {
      return res.status(400).json({ error: 'No eligible products for this discount code' });
    }

    res.json({ success: true, discountPercentage: discount.discount, totalDiscount, eligibleProducts });
  } catch (error) {
    console.error('Error verifying discount code:', error);
    res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// --------------------
// CREATE CHECKOUT CODE
// --------------------
router.post('/createCheckoutCode', authenticateToken, async (req, res) => {
  try {
    const {
      code,
      discount,
      type = 'all',
      appliesTo = [],
      usageLimit = 1,
      isActive = true,
      appliesToModel,
      notifySubscribers,
      promoEmailSubject,
      promoEmailIntro,
    } = req.body;

    const newCheckoutCode = new DiscountCode({
      id: `code${Math.floor(Math.random() * 10000)}`,
      code,
      discount,
      type,
      appliesTo,
      appliesToModel: appliesToModel || (appliesTo.length > 0 ? 'Product' : 'Service'),
      usageLimit: Number(usageLimit),
      clientID: req.clientId,
      isActive
    });

    await newCheckoutCode.save();

    const wantsNewsletter = notifySubscribers === true || notifySubscribers === 'true';
    let newsletter = null;
    let wishlistAlerts = null;

    if (wantsNewsletter) {
      const subscriberCount = await NewsletterService.getSubscriberCount(req.clientId, true);
      const clientDoc = await Client.findOne({ clientID: req.clientId });
      const smtpOk = clientDoc && resolveSmtpHost(clientDoc);

      if (!smtpOk) {
        newsletter = { status: 'skipped', reason: 'smtp_not_configured' };
      } else if (!subscriberCount) {
        newsletter = { status: 'skipped', reason: 'no_active_subscribers' };
      } else {
        const brand = escapeHtml(clientDoc.companyName || 'Our store');
        const codeEsc = escapeHtml(code);
        const subject =
          (promoEmailSubject && String(promoEmailSubject).trim().slice(0, 200)) ||
          `New offer — ${code} (${discount}% off)`;
        const introHtml =
          promoEmailIntro && String(promoEmailIntro).trim()
            ? escapeHtml(String(promoEmailIntro).trim()).replace(/\n/g, '<br>')
            : `We just published a new checkout code. Use <strong>${codeEsc}</strong> at checkout to save <strong>${escapeHtml(String(discount))}%</strong>.`;

        const html = `
        <div style="font-family: Arial, Helvetica, sans-serif; max-width: 640px; margin: auto; color: #111827;">
          <h2 style="color: #1f2937;">${brand}</h2>
          <p>${introHtml}</p>
          <div style="margin: 20px 0; padding: 16px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;">
            <p style="margin: 6px 0;"><strong>Code:</strong> ${codeEsc}</p>
            <p style="margin: 6px 0;"><strong>Discount:</strong> ${escapeHtml(String(discount))}%</p>
            <p style="margin: 6px 0;"><strong>Scope:</strong> ${escapeHtml(String(type))}</p>
          </div>
          <p style="font-size: 14px; color: #6b7280;">Terms and exclusions may apply — see checkout or contact us for details.</p>
        </div>`;

        const text = `${clientDoc.companyName || 'Our store'} — new code ${code}: ${discount}% off (scope: ${type}).`;

        newsletter = {
          status: 'started',
          estimatedRecipients: subscriberCount,
          newsletterId: `promo_checkout_${newCheckoutCode._id}`,
        };

        const newsletterData = {
          subject,
          html,
          text,
          newsletterId: newsletter.newsletterId,
          enableTracking: true,
        };

        setImmediate(() => {
          NewsletterService.sendNewsletter(clientDoc, newsletterData, { useSubscribers: true })
            .then((result) => console.log('✅ Promo newsletter finished:', result.newsletterId, result.totalSent, 'sent'))
            .catch((err) => console.error('💥 Promo newsletter failed:', err.message));
        });
      }
    }

    const productLikeCode =
      (newCheckoutCode.appliesToModel || '').toLowerCase() === 'product' ||
      ['all', 'product', 'category'].includes(String(newCheckoutCode.type || '').toLowerCase());
    if (productLikeCode && Array.isArray(newCheckoutCode.appliesTo) && newCheckoutCode.appliesTo.length) {
      wishlistAlerts = { status: 'started' };
      setImmediate(() => {
        sendWishlistCheckoutCodeAlerts({
          clientId: req.clientId,
          code: newCheckoutCode.code,
          discount: newCheckoutCode.discount,
          appliesTo: newCheckoutCode.appliesTo,
          type: newCheckoutCode.type,
        })
          .then((result) => console.log('✅ Wishlist checkout-code alerts:', result))
          .catch((err) => console.error('💥 Wishlist checkout-code alerts failed:', err.message));
      });
    } else {
      wishlistAlerts = { status: 'skipped', reason: 'not_product_targeted' };
    }

    res.status(201).json({
      message: 'Checkout code created successfully!',
      checkoutCode: newCheckoutCode,
      newsletter,
      wishlistAlerts,
    });
  } catch (err) {
    console.error('Error creating checkout code:', err);
    res.status(400).json({ error: 'Failed to create checkout code', details: err.message });
  }
});

// --------------------
// GET ALL CHECKOUT CODES
// --------------------
router.get('/checkout-codes', authenticateToken, async (req, res) => {
  try {
    const codes = await DiscountCode.find({ clientID: req.clientId });
    if (!codes.length) return res.status(404).json({ error: 'No checkout codes found' });
    res.json(codes);
  } catch (err) {
    console.error('Error fetching checkout codes:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------
// UPDATE CHECKOUT CODE
// --------------------
router.put('/checkout-codes/:id', authenticateToken, async (req, res) => {
  try {
    const updated = await DiscountCode.findOneAndUpdate(
      { _id: req.params.id, clientID: req.clientId },
      { isActive: req.body.isActive },
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: 'Checkout code not found or does not belong to the client' });
    res.json(updated);
  } catch (err) {
    console.error('Error updating checkout code:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------
// DELETE CHECKOUT CODE
// --------------------
router.delete('/checkout-codes/:id', authenticateToken, async (req, res) => {
  try {
    const deleted = await DiscountCode.findOneAndDelete({ _id: req.params.id, clientID: req.clientId });
    if (!deleted) return res.status(404).json({ error: 'Checkout code not found or does not belong to client' });
    res.json({ success: true, message: 'Checkout code deleted successfully' });
  } catch (err) {
    console.error('Error deleting checkout code:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;
