const WishList = require('../models/wishList');
const Customer = require('../models/customer');
const Client = require('../models/client');
const Product = require('../models/product');
const { sendMailWithRetry } = require('../helpers/mailer');
const { decrypt } = require('../helpers/encryption');
const { resolveSmtpHost, resolveSmtpPort, resolveSmtpSecure } = require('../helpers/mailHost');
const { resolveEmailBrand } = require('../helpers/emailDesignTokens');
const {
  buildKhanaEmail,
  escapeHtml,
  ctaButton,
} = require('../helpers/transactionalEmailLayout');
const { inlineEmailBannerLogosAsync } = require('../helpers/inlineEmailBannerLogo');
const { formatEmailAttachments } = require('../helpers/formatEmailAttachments');

const COOLDOWN_MS = Number(process.env.WISHLIST_NOTIFY_COOLDOWN_MS || 24 * 60 * 60 * 1000);

const CLIENT_EMAIL_FIELDS =
  'companyName businessEmail businessEmailPassword smtpHost smtpPort return_url clientID emailLogoUrl emailPrimaryColor dashboardThemeColor';

function salePct(p) {
  return Math.min(100, Math.max(0, Number(p?.salePercentage) || 0));
}

function effectiveUnitPrice(product, unitPrice) {
  const pct = salePct(product);
  return Number(unitPrice) * (1 - pct / 100);
}

/**
 * Resolve catalog line for a product row (base or variant).
 * @returns {{ unitPrice: number, stock: number, label: string } | null}
 */
function resolveLine(product, variantName, variantValue) {
  if (!product) return null;
  const vn = String(variantName || '').trim();
  const vv = String(variantValue || '').trim();
  if (!vn || !vv) {
    return {
      unitPrice: Number(product.price) || 0,
      stock: Number(product.countInStock) || 0,
      label: '',
    };
  }
  for (const v of product.variants || []) {
    if (String(v.name || '').trim() !== vn) continue;
    for (const val of v.values || []) {
      if (String(val.value || '').trim() === vv) {
        return {
          unitPrice: Number(val.price) || 0,
          stock: Number(val.stock) || 0,
          label: `${vn}: ${vv}`,
        };
      }
    }
  }
  return null;
}

function lineFromSnapshot(product, item) {
  return resolveLine(product, item.variantName, item.variantValue) || resolveLine(product, '', '');
}

function snapshotFromProduct(product, item) {
  const line = lineFromSnapshot(product, item);
  if (!line) return null;
  return {
    lastKnownEffectivePrice: effectiveUnitPrice(product, line.unitPrice),
    lastKnownSalePercent: salePct(product),
    lastKnownStock: line.stock,
  };
}

function storeBaseUrl(client) {
  return client?.return_url ? String(client.return_url).replace(/\/$/, '') : '';
}

function buildWishlistAlertBody({
  customer,
  productName,
  saleHit,
  saleReason,
  restockHit,
  stock,
  variantLabel,
  listName,
  actionUrl,
  shopUrl,
}) {
  const first = escapeHtml(customer?.customerFirstName || 'there');
  const parts = [`<p style="margin:0 0 16px;">Hi ${first},</p>`];

  if (saleHit && saleReason) {
    parts.push(
      `<p style="margin:0 0 16px;"><strong>${escapeHtml(saleReason)}</strong> on <em>${escapeHtml(productName)}</em>.</p>`
    );
  }

  if (restockHit) {
    parts.push(
      `<p style="margin:0 0 16px;"><strong>Back in stock</strong> — <em>${escapeHtml(productName)}</em> is available again${stock > 0 ? ` (${stock} in stock)` : ''}.</p>`
    );
  }

  if (variantLabel) {
    parts.push(`<p style="margin:0 0 16px;">Option: ${escapeHtml(variantLabel)}</p>`);
  }

  if (actionUrl) {
    parts.push(
      ctaButton({
        href: actionUrl,
        label: listName ? `View ${listName}` : 'View your wish list',
      })
    );
  }

  if (shopUrl && shopUrl !== actionUrl) {
    parts.push(
      `<p style="margin:16px 0 0;text-align:center;">` +
        `<a href="${escapeHtml(shopUrl)}" style="color:#2563eb;text-decoration:none;font-size:14px;">Browse the store</a>` +
        `</p>`
    );
  }

  return parts.join('\n');
}

function buildWishlistAlertSubject({ productName, saleHit, restockHit }) {
  if (saleHit && restockHit) {
    return `Wish list update: ${productName} — sale & restock`;
  }
  if (saleHit) return `Wish list sale: ${productName}`;
  return `${productName} is back in stock`;
}

function buildWishlistAlertHeadline({ saleHit, restockHit }) {
  if (saleHit && restockHit) return 'Wish list update';
  if (saleHit) return 'Sale on your wish list';
  return 'Back in stock';
}

function buildWishlistAlertPreheader({ productName, saleHit, restockHit, saleReason }) {
  if (saleHit && restockHit) {
    return `${saleReason || 'Price update'} and ${productName} is back in stock.`;
  }
  if (saleHit) return saleReason || `${productName} is on sale on your wish list.`;
  return `${productName} is available again — shop before it sells out.`;
}

async function sendWishlistProductAlertEmail({
  customer,
  client,
  productName,
  saleHit,
  saleReason,
  restockHit,
  stock,
  variantLabel,
  listName,
  actionUrl,
  shopUrl,
}) {
  const decryptedEmail = decrypt(client.businessEmail);
  const decryptedPass = decrypt(client.businessEmailPassword);
  const smtpHost = resolveSmtpHost(client);
  const smtpPort = resolveSmtpPort(client, smtpHost);
  if (!smtpHost) {
    throw new Error('SMTP host could not be resolved for client');
  }

  const brand = resolveEmailBrand(client);
  const brandName = String(client.companyName || 'Our store');
  const subject = buildWishlistAlertSubject({ productName, saleHit, restockHit });
  const headline = buildWishlistAlertHeadline({ saleHit, restockHit });
  const preheader = buildWishlistAlertPreheader({
    productName,
    saleHit,
    restockHit,
    saleReason,
  });

  const bodyHtml = buildWishlistAlertBody({
    customer,
    productName,
    saleHit,
    saleReason,
    restockHit,
    stock,
    variantLabel,
    listName,
    actionUrl,
    shopUrl,
  });

  const html = buildKhanaEmail({
    headline,
    title: subject,
    preheader,
    bodyHtml,
    brandName,
    logoUrl: brand.logoUrl || undefined,
    showKhanaLogo: false,
    footerHtml: `Automated wishlist alert from ${escapeHtml(brandName)}. Manage alerts in your account settings.`,
    primaryColor: brand.primaryColor,
  });

  const textLines = [
    `Hi ${customer.customerFirstName || 'there'},`,
    '',
  ];
  if (saleHit && saleReason) textLines.push(`${saleReason} on ${productName}.`);
  if (restockHit) {
    textLines.push(`${productName} is back in stock${stock > 0 ? ` (${stock} available)` : ''}.`);
  }
  if (variantLabel) textLines.push(`Option: ${variantLabel}`);
  if (actionUrl) textLines.push('', `View your list: ${actionUrl}`);
  if (shopUrl && shopUrl !== actionUrl) textLines.push(`Shop: ${shopUrl}`);
  textLines.push('', `— ${brandName}`);
  const text = textLines.join('\n');

  const { html: htmlOut, attachments } = await inlineEmailBannerLogosAsync(html, [], {});

  await sendMailWithRetry(
    {
      host: smtpHost,
      port: smtpPort,
      secure: resolveSmtpSecure(smtpPort),
      user: decryptedEmail,
      pass: decryptedPass,
      from: `"${client.companyName}" <${decryptedEmail}>`,
      to: customer.emailAddress,
      subject,
      text,
      html: htmlOut,
      attachments: formatEmailAttachments(attachments || []),
      clientID: client.clientID,
      saveToSent: false,
    },
    3
  );
}

/**
 * After adding/updating a wishlist item, store price/stock baseline.
 */
async function refreshItemSnapshot(wishlistId, itemId, product) {
  const wl = await WishList.findById(wishlistId);
  if (!wl) return;
  const item = wl.items.id(itemId);
  if (!item || !product) return;
  const snap = snapshotFromProduct(product, item);
  if (!snap) return;
  item.lastKnownEffectivePrice = snap.lastKnownEffectivePrice;
  item.lastKnownSalePercent = snap.lastKnownSalePercent;
  item.lastKnownStock = snap.lastKnownStock;
  await wl.save();
}

/**
 * Compare previous vs current product document (plain or mongoose) and email customers.
 */
async function handleProductUpdate(prevProduct, nextProduct) {
  if (!prevProduct || !nextProduct) return;
  const pid = String(nextProduct._id || nextProduct.id);
  const clientID = nextProduct.clientID;
  if (!pid || !clientID) return;

  const lists = await WishList.find({
    clientID,
    'items.product': pid,
  }).exec();

  if (!lists.length) return;

  const client = await Client.findOne({ clientID }).select(CLIENT_EMAIL_FIELDS);
  if (!client) return;

  const host = resolveSmtpHost(client);
  if (!host) {
    console.warn('wishlistNotify: no SMTP host for client', clientID);
    return;
  }

  const listUrl = storeBaseUrl(client);
  const shopUrl = listUrl || '';

  for (const list of lists) {
    for (const item of list.items) {
      if (String(item.product) !== pid) continue;

      const beforeLine = lineFromSnapshot(prevProduct, item);
      const afterLine = lineFromSnapshot(nextProduct, item);
      if (!beforeLine || !afterLine) continue;

      const effBefore = effectiveUnitPrice(prevProduct, beforeLine.unitPrice);
      const effAfter = effectiveUnitPrice(nextProduct, afterLine.unitPrice);
      const saleBefore = salePct(prevProduct);
      const saleAfter = salePct(nextProduct);

      let saleHit = false;
      let saleReason = '';
      if (item.notifyOnSale) {
        const betterPrice = effAfter < effBefore - 0.005;
        const betterSale = saleAfter > saleBefore + 0.5;
        const cooldownOk =
          !item.lastSaleNotifiedAt || Date.now() - new Date(item.lastSaleNotifiedAt).getTime() > COOLDOWN_MS;
        if (cooldownOk && (betterPrice || betterSale)) {
          saleHit = true;
          if (betterSale && saleAfter > saleBefore) saleReason = `New sale: ${saleAfter}% off`;
          else saleReason = `Price dropped to R${effAfter.toFixed(2)}`;
        }
      }

      let restockHit = false;
      if (item.notifyOnRestock) {
        const wasOut = Number(beforeLine.stock) <= 0;
        const nowIn = Number(afterLine.stock) > 0;
        const cooldownOk =
          !item.lastRestockNotifiedAt ||
          Date.now() - new Date(item.lastRestockNotifiedAt).getTime() > COOLDOWN_MS;
        if (cooldownOk && wasOut && nowIn) restockHit = true;
      }

      if (!saleHit && !restockHit) {
        item.lastKnownEffectivePrice = effAfter;
        item.lastKnownSalePercent = saleAfter;
        item.lastKnownStock = afterLine.stock;
        continue;
      }

      const customer = await Customer.findOne({
        _id: list.customerID,
        clientID: list.clientID,
      });

      const productName = nextProduct.productName || 'Product';
      const deepLink = listUrl ? `${listUrl}/wishlist/${list._id}` : '';

      if (customer?.emailAddress) {
        try {
          await sendWishlistProductAlertEmail({
            customer,
            client,
            productName,
            saleHit,
            saleReason,
            restockHit,
            stock: afterLine.stock,
            variantLabel: afterLine.label,
            listName: list.name,
            actionUrl: deepLink || shopUrl,
            shopUrl,
          });
          if (saleHit) item.lastSaleNotifiedAt = new Date();
          if (restockHit) item.lastRestockNotifiedAt = new Date();
        } catch (e) {
          console.error('wishlistNotify email failed', e.message);
        }
      }

      item.lastKnownEffectivePrice = effAfter;
      item.lastKnownSalePercent = saleAfter;
      item.lastKnownStock = afterLine.stock;
    }

    await list.save();
  }
}

/**
 * Merchant-triggered restock blast for wishlist subscribers (notifyOnRestock).
 */
async function sendManualRestockAlerts(clientID, productId, { force = false } = {}) {
  const product = await Product.findOne({ _id: productId, clientID });
  if (!product) {
    return { sent: 0, failed: 0, skipped: 0, error: 'product_not_found' };
  }
  if (Number(product.countInStock) <= 0) {
    return { sent: 0, failed: 0, skipped: 0, error: 'out_of_stock' };
  }

  const lists = await WishList.find({
    clientID,
    'items.product': productId,
    'items.notifyOnRestock': true,
  });

  const client = await Client.findOne({ clientID }).select(CLIENT_EMAIL_FIELDS);
  if (!client) {
    return { sent: 0, failed: 0, skipped: 0, error: 'client_not_found' };
  }

  if (!resolveSmtpHost(client)) {
    return { sent: 0, failed: 0, skipped: 0, error: 'smtp_not_configured' };
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const pid = String(productId);
  const productName = product.productName || 'Product';
  const listUrl = storeBaseUrl(client);
  const shopUrl = listUrl || '';

  for (const list of lists) {
    let listChanged = false;
    for (const item of list.items) {
      if (String(item.product) !== pid || !item.notifyOnRestock) continue;

      const afterLine = lineFromSnapshot(product, item);
      if (!afterLine || Number(afterLine.stock) <= 0) {
        skipped += 1;
        continue;
      }

      const cooldownOk =
        force ||
        !item.lastRestockNotifiedAt ||
        Date.now() - new Date(item.lastRestockNotifiedAt).getTime() > COOLDOWN_MS;
      if (!cooldownOk) {
        skipped += 1;
        continue;
      }

      const customer = await Customer.findOne({
        _id: list.customerID,
        clientID: list.clientID,
      });

      if (!customer?.emailAddress) {
        skipped += 1;
        continue;
      }

      if (customer.preferences?.notificationPreferences?.restockAlerts === false) {
        skipped += 1;
        continue;
      }

      const deepLink = listUrl ? `${listUrl}/wishlist/${list._id}` : '';

      try {
        await sendWishlistProductAlertEmail({
          customer,
          client,
          productName,
          saleHit: false,
          saleReason: '',
          restockHit: true,
          stock: afterLine.stock,
          variantLabel: afterLine.label,
          listName: list.name,
          actionUrl: deepLink || shopUrl,
          shopUrl,
        });
        item.lastRestockNotifiedAt = new Date();
        item.lastKnownStock = afterLine.stock;
        listChanged = true;
        sent += 1;
      } catch (e) {
        console.error('manual restock email failed', e.message);
        failed += 1;
      }
    }
    if (listChanged) await list.save();
  }

  return { sent, failed, skipped, error: null };
}

module.exports = {
  resolveLine,
  effectiveUnitPrice,
  snapshotFromProduct,
  refreshItemSnapshot,
  handleProductUpdate,
  sendManualRestockAlerts,
  sendWishlistProductAlertEmail,
};
