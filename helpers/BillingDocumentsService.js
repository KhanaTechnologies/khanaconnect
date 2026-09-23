/**
 * Khana credit invoices (EFT packs) + account statements.
 * Printable HTML — open in browser → Print / Save as PDF.
 */

const SaasTransaction = require('../models/SaasTransaction');
const Client = require('../models/client');
const SaasBillingAccount = require('../models/SaasBillingAccount');
const { getBusinessBankDetails } = require('./khanaBankDetails');
const { getCreditPack } = require('./creditPacks');

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatZar(n) {
  return `R${Number(n || 0).toFixed(2)}`;
}

function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-ZA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

async function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;
  const count = await SaasTransaction.countDocuments({
    type: 'topup',
    'metadata.invoiceNumber': { $regex: `^${prefix}` },
  });
  return `${prefix}${String(count + 1).padStart(5, '0')}`;
}

async function assignInvoiceToTransaction(txn) {
  if (!txn) return null;
  const meta = txn.metadata && typeof txn.metadata === 'object' ? { ...txn.metadata } : {};
  if (meta.invoiceNumber) return meta.invoiceNumber;

  const invoiceNumber = await nextInvoiceNumber();
  meta.invoiceNumber = invoiceNumber;
  meta.invoiceStatus = txn.status === 'success' ? 'paid' : 'unpaid';
  meta.invoiceIssuedAt = new Date().toISOString();
  txn.metadata = meta;
  if (typeof txn.markModified === 'function') txn.markModified('metadata');
  await txn.save();
  return invoiceNumber;
}

async function loadClientBillingParty(clientId) {
  const client = await Client.findOne({ clientID: clientId })
    .select('clientID companyName email businessEmail phone address city')
    .lean();
  return {
    clientId: clientId,
    name: client?.companyName || clientId,
    email: client?.businessEmail || client?.email || '',
    phone: client?.phone || '',
    address: [client?.address, client?.city].filter(Boolean).join(', '),
  };
}

function invoicePayloadFromTxn(txn, party, bank) {
  const meta = txn.metadata || {};
  const pack = meta.packId ? getCreditPack(meta.packId) : null;
  const status =
    txn.status === 'success'
      ? 'paid'
      : txn.status === 'failed'
        ? 'cancelled'
        : meta.invoiceStatus || 'unpaid';

  return {
    documentType: 'invoice',
    invoiceNumber: meta.invoiceNumber || null,
    paymentReference: txn.reference,
    status,
    issuedAt: meta.invoiceIssuedAt || txn.created_at,
    paidAt: meta.confirmedAt || (status === 'paid' ? txn.updated_at : null),
    currency: 'ZAR',
    billTo: party,
    supplier: {
      name: bank.accountName || 'Khana Technologies',
      bankName: bank.bankName || '',
      accountNumber: bank.configured ? bank.accountNumber : '',
      branchCode: bank.branchCode || '',
      instructions: bank.instructions || '',
    },
    lineItems: [
      {
        description: pack
          ? `Khana prepaid credits — ${pack.name} pack (${pack.credits} credits)`
          : `Khana prepaid credits (${txn.credits} credits)`,
        quantity: 1,
        unitAmount: Number(txn.amount || 0),
        credits: Number(txn.credits || 0),
        total: Number(txn.amount || 0),
      },
    ],
    subtotal: Number(txn.amount || 0),
    total: Number(txn.amount || 0),
    credits: Number(txn.credits || 0),
    method: txn.method,
    notes:
      status === 'unpaid'
        ? `Pay by EFT using reference ${txn.reference}. Credits are applied after deposit confirmation.`
        : status === 'paid'
          ? `Payment received. ${txn.credits} credits were added to your Khana balance.`
          : 'This invoice was cancelled.',
  };
}

function renderDocumentHtml({ title, subtitle, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Georgia, 'Times New Roman', serif; color: #111; margin: 40px; line-height: 1.45; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    .muted { color: #555; font-size: 13px; }
    .row { display: flex; justify-content: space-between; gap: 24px; margin: 24px 0; }
    .box { flex: 1; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th, td { border-bottom: 1px solid #ddd; padding: 8px 6px; text-align: left; font-size: 13px; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #444; }
    .right { text-align: right; }
    .badge { display: inline-block; padding: 2px 8px; border: 1px solid #333; border-radius: 999px; font-size: 11px; text-transform: uppercase; }
    .totals { margin-top: 16px; width: 280px; margin-left: auto; }
    .totals td { border: none; padding: 4px 0; }
    .footer { margin-top: 40px; font-size: 12px; color: #666; }
    @media print { body { margin: 16px; } .no-print { display: none; } }
  </style>
</head>
<body>
  <p class="no-print muted"><button onclick="window.print()">Print / Save as PDF</button></p>
  <h1>${escapeHtml(title)}</h1>
  <p class="muted">${escapeHtml(subtitle || '')}</p>
  ${bodyHtml}
</body>
</html>`;
}

function invoiceToHtml(inv) {
  const lines = (inv.lineItems || [])
    .map(
      (li) => `<tr>
      <td>${escapeHtml(li.description)}</td>
      <td class="right">${escapeHtml(String(li.quantity))}</td>
      <td class="right">${escapeHtml(formatZar(li.unitAmount))}</td>
      <td class="right">${escapeHtml(formatZar(li.total))}</td>
    </tr>`
    )
    .join('');

  const body = `
  <p><span class="badge">${escapeHtml(inv.status)}</span>
    &nbsp; Invoice <strong>${escapeHtml(inv.invoiceNumber || '—')}</strong>
    · Payment ref <strong>${escapeHtml(inv.paymentReference)}</strong></p>
  <div class="row">
    <div class="box">
      <p class="muted">Bill to</p>
      <p><strong>${escapeHtml(inv.billTo.name)}</strong><br/>
      ${escapeHtml(inv.billTo.clientId)}<br/>
      ${escapeHtml(inv.billTo.email)}<br/>
      ${escapeHtml(inv.billTo.phone)}<br/>
      ${escapeHtml(inv.billTo.address)}</p>
    </div>
    <div class="box">
      <p class="muted">From / pay to</p>
      <p><strong>${escapeHtml(inv.supplier.name)}</strong><br/>
      ${escapeHtml(inv.supplier.bankName)}<br/>
      Acc ${escapeHtml(inv.supplier.accountNumber)}
      ${inv.supplier.branchCode ? ` · Branch ${escapeHtml(inv.supplier.branchCode)}` : ''}</p>
      <p class="muted">Issued ${escapeHtml(formatDate(inv.issuedAt))}
      ${inv.paidAt ? ` · Paid ${escapeHtml(formatDate(inv.paidAt))}` : ''}</p>
    </div>
  </div>
  <table>
    <thead><tr><th>Description</th><th class="right">Qty</th><th class="right">Amount</th><th class="right">Total</th></tr></thead>
    <tbody>${lines}</tbody>
  </table>
  <table class="totals">
    <tr><td>Credits</td><td class="right">${escapeHtml(String(inv.credits))}</td></tr>
    <tr><td><strong>Total due</strong></td><td class="right"><strong>${escapeHtml(formatZar(inv.total))}</strong></td></tr>
  </table>
  <p class="footer">${escapeHtml(inv.notes)}<br/>${escapeHtml(inv.supplier.instructions || '')}</p>`;

  return renderDocumentHtml({
    title: `Invoice ${inv.invoiceNumber || inv.paymentReference}`,
    subtitle: 'Khana prepaid credits',
    bodyHtml: body,
  });
}

function statementToHtml(stmt) {
  const rows = (stmt.lines || [])
    .map(
      (l) => `<tr>
      <td>${escapeHtml(formatDate(l.date))}</td>
      <td>${escapeHtml(l.description)}</td>
      <td class="right">${l.creditsIn ? escapeHtml(String(l.creditsIn)) : '—'}</td>
      <td class="right">${l.creditsOut ? escapeHtml(String(l.creditsOut)) : '—'}</td>
      <td class="right">${escapeHtml(formatZar(l.amountZar || 0))}</td>
      <td>${escapeHtml(l.status || '')}</td>
    </tr>`
    )
    .join('');

  const body = `
  <div class="row">
    <div class="box">
      <p class="muted">Account</p>
      <p><strong>${escapeHtml(stmt.billTo.name)}</strong> (${escapeHtml(stmt.billTo.clientId)})</p>
    </div>
    <div class="box">
      <p class="muted">Period</p>
      <p>${escapeHtml(formatDate(stmt.from))} → ${escapeHtml(formatDate(stmt.to))}</p>
      <p>Opening ${escapeHtml(String(stmt.openingBalance))} · Closing ${escapeHtml(String(stmt.closingBalance))} credits</p>
    </div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Date</th><th>Description</th>
        <th class="right">In</th><th class="right">Out</th>
        <th class="right">ZAR</th><th>Status</th>
      </tr>
    </thead>
    <tbody>${rows || '<tr><td colspan="6">No movements in this period.</td></tr>'}</tbody>
  </table>
  <table class="totals">
    <tr><td>Credits added</td><td class="right">${escapeHtml(String(stmt.totals.creditsIn))}</td></tr>
    <tr><td>Credits used</td><td class="right">${escapeHtml(String(stmt.totals.creditsOut))}</td></tr>
    <tr><td>ZAR received (confirmed)</td><td class="right">${escapeHtml(formatZar(stmt.totals.zarIn))}</td></tr>
  </table>
  <p class="footer">Statement of Khana credit wallet activity. Meta ad spend is billed separately by Meta.</p>`;

  return renderDocumentHtml({
    title: 'Credit account statement',
    subtitle: stmt.billTo.name,
    bodyHtml: body,
  });
}

class BillingDocumentsService {
  static async ensureInvoiceForReference(reference) {
    const ref = String(reference || '').trim();
    const txn = await SaasTransaction.findOne({ reference: ref, type: 'topup' });
    if (!txn) throw httpError('Top-up / invoice not found', 404);
    await assignInvoiceToTransaction(txn);
    return txn;
  }

  static async getInvoice(clientId, reference, { asHtml = false } = {}) {
    const txn = await this.ensureInvoiceForReference(reference);
    if (clientId && String(txn.client_id) !== String(clientId)) {
      throw httpError('Invoice not found for this workspace', 404);
    }
    const party = await loadClientBillingParty(txn.client_id);
    const bank = getBusinessBankDetails();
    const inv = invoicePayloadFromTxn(txn.toObject ? txn.toObject() : txn, party, bank);
    if (asHtml) return { html: invoiceToHtml(inv), invoice: inv };
    return inv;
  }

  static async listInvoices(clientId, { limit = 50 } = {}) {
    const rows = await SaasTransaction.find({
      client_id: String(clientId).trim(),
      type: 'topup',
      method: { $in: ['eft', 'manual', 'payfast'] },
    })
      .sort({ created_at: -1 })
      .limit(Math.min(Math.max(Number(limit) || 50, 1), 200));

    const out = [];
    for (const txn of rows) {
      if (!txn.metadata?.invoiceNumber && (txn.method === 'eft' || txn.status === 'success')) {
        await assignInvoiceToTransaction(txn);
      }
      if (!txn.metadata?.invoiceNumber) continue;
      const party = { clientId: txn.client_id, name: txn.client_id };
      out.push(
        invoicePayloadFromTxn(txn.toObject ? txn.toObject() : txn, party, getBusinessBankDetails())
      );
    }
    return out;
  }

  static async buildStatement(clientId, { from = null, to = null } = {}) {
    const id = String(clientId).trim();
    const end = to ? new Date(to) : new Date();
    const start = from
      ? new Date(from)
      : new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw httpError('Invalid from/to dates', 400);
    }

    const account = await SaasBillingAccount.findOne({ client_id: id }).lean();
    const allBefore = await SaasTransaction.find({
      client_id: id,
      status: 'success',
      created_at: { $lt: start },
    })
      .select('type credits')
      .lean();

    let opening = 0;
    for (const t of allBefore) {
      if (t.type === 'topup') opening += Number(t.credits || 0);
      else if (t.type === 'deduction') opening -= Number(t.credits || 0);
    }
    opening = Number(opening.toFixed(4));

    const rows = await SaasTransaction.find({
      client_id: id,
      created_at: { $gte: start, $lte: end },
    })
      .sort({ created_at: 1 })
      .lean();

    let running = opening;
    let creditsIn = 0;
    let creditsOut = 0;
    let zarIn = 0;
    const lines = [];

    for (const t of rows) {
      const meta = t.metadata || {};
      const isTopup = t.type === 'topup';
      const credits = Number(t.credits || 0);
      const applied = t.status === 'success';
      if (applied && isTopup) {
        running += credits;
        creditsIn += credits;
        zarIn += Number(t.amount || 0);
      } else if (applied && !isTopup) {
        running -= credits;
        creditsOut += credits;
      }

      lines.push({
        date: t.created_at,
        description:
          t.method === 'monthly_grant'
            ? `Monthly included credits (${meta.plan || 'plan'} · ${meta.period || ''}) · ${t.reference}`
            : t.method === 'monthly_expiry'
              ? `Included credits expired (unused) · ${t.reference}`
              : isTopup
                ? `Top-up ${t.method}${meta.packId ? ` (${meta.packId})` : ''}${meta.invoiceNumber ? ` · ${meta.invoiceNumber}` : ''} · ${t.reference}`
                : `Usage ${meta.service || 'service'}${meta.messageType ? `/${meta.messageType}` : ''} · ${t.reference}`,
        creditsIn: isTopup && applied ? credits : 0,
        creditsOut: !isTopup && applied ? credits : 0,
        amountZar: isTopup ? Number(t.amount || 0) : 0,
        status: t.status,
        balanceAfter: applied ? Number(running.toFixed(4)) : null,
        reference: t.reference,
        invoiceNumber: meta.invoiceNumber || null,
      });
    }

    const party = await loadClientBillingParty(id);
    return {
      documentType: 'statement',
      billTo: party,
      from: start,
      to: end,
      openingBalance: opening,
      closingBalance: Number(running.toFixed(4)),
      currentBalance: Number(account?.credit_balance || running).toFixed
        ? Number(Number(account?.credit_balance || running).toFixed(4))
        : Number(account?.credit_balance || running),
      totals: {
        creditsIn: Number(creditsIn.toFixed(4)),
        creditsOut: Number(creditsOut.toFixed(4)),
        zarIn: Number(zarIn.toFixed(2)),
      },
      lines,
    };
  }

  static async getStatement(clientId, opts = {}, { asHtml = false } = {}) {
    const stmt = await this.buildStatement(clientId, opts);
    if (asHtml) return { html: statementToHtml(stmt), statement: stmt };
    return stmt;
  }

  static assignInvoiceToTransaction = assignInvoiceToTransaction;
}

module.exports = BillingDocumentsService;
