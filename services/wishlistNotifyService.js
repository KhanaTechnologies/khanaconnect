const WishList = require('../models/wishList');
const Customer = require('../models/customer');
const Client = require('../models/client');
const { sendMail } = require('../helpers/mailer');
const { resolveSmtpHost, resolveSmtpPort, resolveSmtpSecure } = require('../helpers/mailHost');

const COOLDOWN_MS = Number(process.env.WISHLIST_NOTIFY_COOLDOWN_MS || 24 * 60 * 60 * 1000);

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

  const client = await Client.findOne({ clientID }).select(
    'companyName businessEmail businessEmailPassword smtpHost smtpPort return_url'
  );
  if (!client) return;

  const host = resolveSmtpHost(client);
  const port = resolveSmtpPort(client, host);
  if (!host) {
    console.warn('wishlistNotify: no SMTP host for client', clientID);
    return;
  }

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
          else saleReason = `Price dropped to ${effAfter.toFixed(2)}`;
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
      const listUrl = client.return_url ? String(client.return_url).replace(/\/$/, '') : '';
      const deepLink = listUrl ? `${listUrl}/wishlist/${list._id}` : '';

      const parts = [];
      if (saleHit) parts.push(`<p><strong>${saleReason}</strong> on <em>${productName}</em>.</p>`);
      if (restockHit) {
        parts.push(
          `<p><strong>Back in stock</strong> — <em>${productName}</em> is available again (${afterLine.stock} in stock).</p>`
        );
      }
      if (afterLine.label) parts.push(`<p>Option: ${afterLine.label}</p>`);
      if (deepLink) parts.push(`<p><a href="${deepLink}">View your list: ${list.name}</a></p>`);

      const subject =
        saleHit && restockHit
          ? `Wish list update: ${productName} — sale & restock`
          : saleHit
            ? `Wish list sale: ${productName}`
            : `Wish list: ${productName} is back in stock`;

      const html = `<div style="font-family:sans-serif">${parts.join('')}<p style="color:#666;font-size:12px">${client.companyName || ''}</p></div>`;
      const text = parts.map((p) => p.replace(/<[^>]+>/g, ' ')).join('\n');

      if (customer?.emailAddress) {
        try {
          await sendMail({
            host,
            port,
            secure: resolveSmtpSecure(port),
            user: client.businessEmail,
            pass: client.businessEmailPassword,
            from: `"${client.companyName}" <${client.businessEmail}>`,
            to: customer.emailAddress,
            subject,
            text,
            html,
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

module.exports = {
  resolveLine,
  effectiveUnitPrice,
  snapshotFromProduct,
  refreshItemSnapshot,
  handleProductUpdate,
};
