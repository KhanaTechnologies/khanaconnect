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
const { buildPromoNewsletterBuilderPayload } = require('../helpers/promoNewsletterBuilder');
const { escapeHtml } = require('../helpers/signatureHtml');
const { buildKhanaEmail, ctaButton, neutralPanel } = require('../helpers/transactionalEmailLayout');
const { resolveSmtpHost, resolveSmtpPort, resolveSmtpSecure } = require('../helpers/mailHost');
const { sendMail } = require('../helpers/mailer');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');
const { createDashboardAuth } = require('../helpers/dashboardAuth');
const { recordTeamActivityFromRequest } = require('../helpers/teamActivity');

// Storefront checkout — accepts client API token (no team member required)
const authenticateStoreToken = (req, res, next) => {
  const token = req.headers.authorization;
  if (!token || !token.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
  }
  const tokenValue = token.split(' ')[1];
  try {
    const { decoded } = verifyJwtWithAnySecret(jwt, tokenValue);
    if (!decoded?.clientID) return res.status(403).json({ error: 'Forbidden - Invalid token' });
    req.clientId = decoded.clientID;
    next();
  } catch (_err) {
    return res.status(403).json({ error: 'Forbidden - Invalid token' });
  }
};

const authenticateToken = createDashboardAuth('sales');

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
    const bodyHtml = `
          <p style="margin:0 0 16px;">Hi ${firstName},</p>
          <p style="margin:0 0 16px;">Good news — a new discount code now applies to item(s) on your wish list:</p>
          <ul style="list-style:none;padding:0;margin:0 0 20px;">${listItemsHtml}</ul>
          ${neutralPanel({
            html: `
              <p style="margin:0 0 8px;"><strong>Code:</strong> ${escapeHtml(String(code))}</p>
              <p style="margin:0;"><strong>Discount:</strong> ${escapeHtml(String(discount))}% off</p>
            `,
          })}
          ${websiteUrl ? ctaButton({ href: websiteUrl, label: 'Visit website' }) : ''}
    `;
    const html = buildKhanaEmail({
      headline: 'Wish list match found',
      title: `Wish list match — ${company}`,
      preheader: `Code ${code} (${discount}% off) applies to your wish list.`,
      bodyHtml,
      brandName: String(clientDoc.companyName || 'Our store'),
      logoUrl: (clientDoc.emailLogoUrl || '').trim() || undefined,
      showKhanaLogo: false,
      footerHtml: 'You receive this because sale alerts are enabled for your wish list items.',
    });
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
router.post('/verify-discount-code', authenticateStoreToken, async (req, res) => {
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

      newsletter = buildPromoNewsletterBuilderPayload({
        code,
        discount,
        type,
        promoEmailSubject,
        promoEmailIntro,
        checkoutCodeId: newCheckoutCode._id,
        companyName: clientDoc?.companyName,
      });

      if (!smtpOk) {
        newsletter.warnings = ['smtp_not_configured'];
      } else if (!subscriberCount) {
        newsletter.warnings = ['no_active_subscribers'];
      } else {
        newsletter.estimatedRecipients = subscriberCount;
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
    recordTeamActivityFromRequest(req, {
      category: 'sales',
      action: 'discount.created',
      summary: `Checkout code created: ${newCheckoutCode.code}`,
      metadata: { codeId: String(newCheckoutCode._id), code: newCheckoutCode.code },
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
