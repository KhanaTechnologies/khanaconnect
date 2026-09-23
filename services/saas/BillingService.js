const mongoose = require('mongoose');
const Client = require('../../models/client');
const SaasBillingAccount = require('../../models/SaasBillingAccount');
const SaasTransaction = require('../../models/SaasTransaction');
const PricingService = require('./PricingService');
const { listCreditPacks, prepaidCheaperHint, getCreditPack, creditsForTopupPayment } = require('../../helpers/creditPacks');
const {
  allowanceForPlan,
  currentPeriodKey,
  periodExpiresAt,
  listAllowances,
} = require('../../helpers/monthlyCreditAllowance');
const { isClientSubscriptionActive } = require('../../helpers/clientSubscription');

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function syncTotalBalance(account) {
  const included = Math.max(0, Number(account.included_credit_balance || 0));
  const purchased = Math.max(0, Number(account.purchased_credit_balance || 0));
  account.included_credit_balance = Number(included.toFixed(4));
  account.purchased_credit_balance = Number(purchased.toFixed(4));
  account.credit_balance = Number((included + purchased).toFixed(4));
  return account;
}

/**
 * Deduct credits: included pool first, then purchased.
 * Mutates account in place; caller saves.
 */
function applyDeductionToPools(account, creditsToDeduct) {
  let remaining = Number(creditsToDeduct || 0);
  const fromIncluded = Math.min(Number(account.included_credit_balance || 0), remaining);
  account.included_credit_balance = Number(
    (Number(account.included_credit_balance || 0) - fromIncluded).toFixed(4)
  );
  remaining = Number((remaining - fromIncluded).toFixed(4));
  const fromPurchased = Math.min(Number(account.purchased_credit_balance || 0), remaining);
  account.purchased_credit_balance = Number(
    (Number(account.purchased_credit_balance || 0) - fromPurchased).toFixed(4)
  );
  remaining = Number((remaining - fromPurchased).toFixed(4));
  syncTotalBalance(account);
  return { fromIncluded, fromPurchased, remaining };
}

class BillingService {
  static syncTotalBalance = syncTotalBalance;

  static async ensureAccount(clientId) {
    let acct = await SaasBillingAccount.findOne({ client_id: clientId });
    if (!acct) {
      acct = await SaasBillingAccount.create({
        client_id: clientId,
        credit_balance: 0,
        included_credit_balance: 0,
        purchased_credit_balance: 0,
        pools_migrated: true,
      });
      return acct;
    }

    if (!acct.pools_migrated) {
      const total = Number(acct.credit_balance || 0);
      const included = Number(acct.included_credit_balance || 0);
      const purchased = Number(acct.purchased_credit_balance || 0);
      if (included === 0 && purchased === 0 && total > 0) {
        acct.purchased_credit_balance = total;
        acct.included_credit_balance = 0;
      } else if (included + purchased > 0) {
        // pools already set somehow
      } else {
        acct.purchased_credit_balance = total;
        acct.included_credit_balance = 0;
      }
      acct.pools_migrated = true;
      syncTotalBalance(acct);
      await acct.save();
    } else {
      syncTotalBalance(acct);
    }
    return acct;
  }

  static serializeAccount(account, { plan = 'starter', allowanceCredits = null } = {}) {
    const period = account?.included_period || currentPeriodKey();
    const { plan: normPlan, credits: allowance } = allowanceForPlan(plan);
    return {
      client_id: account?.client_id,
      credit_balance: Number(account?.credit_balance || 0),
      included_credit_balance: Number(account?.included_credit_balance || 0),
      purchased_credit_balance: Number(account?.purchased_credit_balance || 0),
      included_period: account?.included_period || '',
      total_spent: Number(account?.total_spent || 0),
      included: {
        plan: normPlan,
        allowance: allowanceCredits != null ? allowanceCredits : allowance,
        remaining: Number(account?.included_credit_balance || 0),
        period,
        expiresAt: periodExpiresAt(period),
      },
      purchased: {
        remaining: Number(account?.purchased_credit_balance || 0),
        note: 'Prepaid packs never expire. Used after included credits are finished.',
      },
    };
  }

  static listCreditPacks() {
    const { getBusinessBankDetails } = require('../../helpers/khanaBankDetails');
    return {
      packs: listCreditPacks(),
      hint: prepaidCheaperHint(),
      spotNote:
        'Last-minute / amount-only top-ups use the higher spot rate. Prepaid packs give more credits per rand.',
      monthlyAllowances: listAllowances(),
      bankTransfer: getBusinessBankDetails(),
      paymentMethods: {
        eft: true,
        payfast: Boolean(process.env.PAYFAST_PASSPHRASE),
        note:
          'Prefer EFT to our business account (no gateway fees). Use the exact payment reference. Credits apply after Khana confirms the deposit.',
      },
    };
  }

  /**
   * Grant this month's included credits for an active partnership (idempotent per YYYY-MM).
   * Unused included from the previous period are expired (statement line) then replaced.
   */
  static async ensureMonthlyIncludedCredits(clientId) {
    const id = String(clientId || '').trim();
    if (!id || id === 'Khana') {
      return { skipped: true, reason: 'exempt' };
    }

    const client = await Client.findOne({ clientID: id }).select('subscription role').lean();
    if (!client) return { skipped: true, reason: 'no_client' };

    const active =
      client.role === 'admin' || isClientSubscriptionActive(client);
    if (!active) {
      return { skipped: true, reason: 'inactive_subscription' };
    }

    const period = currentPeriodKey();
    const account = await this.ensureAccount(id);
    if (String(account.included_period || '') === period) {
      return {
        skipped: true,
        reason: 'already_granted',
        account: this.serializeAccount(account, { plan: client.subscription?.plan }),
      };
    }

    const { plan, credits: allowance } = allowanceForPlan(client.subscription?.plan);
    const expired = Number(account.included_credit_balance || 0);

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      if (expired > 0) {
        await SaasTransaction.create(
          [
            {
              client_id: id,
              type: 'deduction',
              amount: 0,
              credits: expired,
              method: 'monthly_expiry',
              reference: `incl-expire-${account.included_period || 'prior'}-${id}`.slice(0, 80),
              status: 'success',
              metadata: {
                service: 'included_credits',
                previousPeriod: account.included_period || null,
                newPeriod: period,
                plan,
              },
            },
          ],
          { session }
        );
      }

      account.included_credit_balance = allowance;
      account.included_period = period;
      syncTotalBalance(account);
      await account.save({ session });

      if (allowance > 0) {
        await SaasTransaction.create(
          [
            {
              client_id: id,
              type: 'topup',
              amount: 0,
              credits: allowance,
              method: 'monthly_grant',
              reference: `incl-grant-${period}-${id}`.slice(0, 80),
              status: 'success',
              metadata: {
                service: 'included_credits',
                period,
                plan,
                allowance,
                expiresAt: periodExpiresAt(period),
              },
            },
          ],
          { session }
        );
      }

      await session.commitTransaction();
      return {
        skipped: false,
        granted: allowance,
        expired,
        period,
        plan,
        account: this.serializeAccount(account, { plan }),
      };
    } catch (e) {
      await session.abortTransaction();
      throw e;
    } finally {
      session.endSession();
    }
  }

  /** Grant included credits for all active subscribed clients (daily Agenda job). */
  static async ensureMonthlyIncludedCreditsForAll({ limit = 500 } = {}) {
    const clients = await Client.find({
      role: { $ne: 'admin' },
      'subscription.status': { $in: ['active', 'trialing', 'past_due'] },
    })
      .select('clientID subscription role')
      .limit(Math.min(Math.max(Number(limit) || 500, 1), 5000))
      .lean();

    let granted = 0;
    let skipped = 0;
    let errors = 0;
    for (const c of clients) {
      if (!isClientSubscriptionActive(c)) {
        skipped += 1;
        continue;
      }
      try {
        const result = await this.ensureMonthlyIncludedCredits(c.clientID);
        if (result?.skipped) skipped += 1;
        else granted += 1;
      } catch (err) {
        errors += 1;
        console.warn(
          `[billing] monthly included grant failed for ${c.clientID}:`,
          err.message || err
        );
      }
    }
    return { scanned: clients.length, granted, skipped, errors };
  }

  /**
   * Client requests a prepaid pack via bank EFT — creates a pending top-up with a unique reference.
   * Credits are NOT applied until confirmEftTopup (admin) after money lands.
   */
  static async createEftTopupRequest(clientId, { packId = '', amountZar = null, note = '' } = {}) {
    const id = String(clientId || '').trim();
    if (!id) throw httpError('clientId is required', 400);

    const { getBusinessBankDetails, bankDetailsConfigured } = require('../../helpers/khanaBankDetails');
    if (!bankDetailsConfigured()) {
      throw httpError(
        'Bank transfer is not configured yet. Ask Khana for account details, or wait until KHANA_BANK_* env is set.',
        503
      );
    }

    const pack = getCreditPack(packId);
    let zar;
    let credits;
    let rateLabel;
    let resolvedPackId = '';

    if (pack) {
      zar = pack.zar;
      credits = pack.credits;
      rateLabel = `pack:${pack.id}`;
      resolvedPackId = pack.id;
    } else if (amountZar != null && Number(amountZar) > 0) {
      const awarded = creditsForTopupPayment({
        amountZar: Number(amountZar),
        packId: '',
        preferSpot: true,
      });
      zar = Number(amountZar);
      credits = awarded.credits;
      rateLabel = awarded.rateLabel;
    } else {
      throw httpError('Choose a prepaid pack (or pass amount_zar).', 400);
    }

    const existingPending = await SaasTransaction.findOne({
      client_id: id,
      type: 'topup',
      method: 'eft',
      status: 'pending',
      'metadata.packId': resolvedPackId || null,
    })
      .sort({ created_at: -1 })
      .lean();

    if (
      existingPending &&
      existingPending.created_at &&
      Date.now() - new Date(existingPending.created_at).getTime() < 7 * 24 * 60 * 60 * 1000 &&
      Number(existingPending.amount) === zar
    ) {
      const BillingDocumentsService = require('../../helpers/BillingDocumentsService');
      const doc = await SaasTransaction.findById(existingPending._id);
      if (doc) await BillingDocumentsService.assignInvoiceToTransaction(doc);
      const fresh = doc ? (doc.toObject ? doc.toObject() : doc) : existingPending;
      return {
        transaction: fresh,
        invoiceNumber: fresh.metadata?.invoiceNumber || null,
        bank: getBusinessBankDetails(),
        reused: true,
        instructions: [
          `Invoice ${fresh.metadata?.invoiceNumber || '—'} — pay R${zar.toFixed(2)}.`,
          `Use payment reference exactly: ${fresh.reference}`,
          getBusinessBankDetails().instructions,
        ].filter(Boolean),
      };
    }

    const slug = String(id)
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 8)
      .toUpperCase() || 'CLIENT';
    const packSlug = (resolvedPackId || 'SPOT').toUpperCase().slice(0, 8);
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    const reference = `KC-${slug}-${packSlug}-${suffix}`.slice(0, 40);

    const txn = await SaasTransaction.create({
      client_id: id,
      type: 'topup',
      amount: zar,
      credits,
      method: 'eft',
      reference,
      status: 'pending',
      metadata: {
        packId: resolvedPackId || null,
        rateLabel,
        note: String(note || '').trim().slice(0, 500),
        channel: 'bank_transfer',
        awaitingConfirmation: true,
        pool: 'purchased',
      },
    });

    const BillingDocumentsService = require('../../helpers/BillingDocumentsService');
    const invoiceNumber = await BillingDocumentsService.assignInvoiceToTransaction(txn);

    return {
      transaction: txn.toObject ? txn.toObject() : txn,
      invoiceNumber,
      bank: getBusinessBankDetails(),
      reused: false,
      instructions: [
        `Invoice ${invoiceNumber} — pay R${zar.toFixed(2)} to the account below.`,
        `Use payment reference exactly: ${reference}`,
        `You will receive ${credits} Khana credits after we confirm the deposit.`,
        getBusinessBankDetails().instructions,
      ].filter(Boolean),
    };
  }

  static async listPendingEftTopups({ clientId = '', limit = 50 } = {}) {
    const q = { type: 'topup', method: 'eft', status: 'pending' };
    if (clientId) q.client_id = String(clientId).trim();
    return SaasTransaction.find(q)
      .sort({ created_at: -1 })
      .limit(Math.min(Math.max(Number(limit) || 50, 1), 200))
      .lean();
  }

  static async listClientEftTopups(clientId, { limit = 20 } = {}) {
    return SaasTransaction.find({
      client_id: String(clientId).trim(),
      type: 'topup',
      method: 'eft',
    })
      .sort({ created_at: -1 })
      .limit(Math.min(Math.max(Number(limit) || 20, 1), 100))
      .lean();
  }

  /**
   * Admin: mark EFT received and credit the purchased pool (idempotent if already success).
   */
  static async confirmEftTopup({ reference, confirmedBy = '', note = '' } = {}) {
    const ref = String(reference || '').trim();
    if (!ref) throw httpError('reference is required', 400);

    const pending = await SaasTransaction.findOne({
      reference: ref,
      type: 'topup',
      method: 'eft',
    });
    if (!pending) throw httpError('EFT top-up request not found', 404);
    if (pending.status === 'success') {
      const account = await this.ensureAccount(pending.client_id);
      return { alreadyConfirmed: true, transaction: pending, account };
    }
    if (pending.status === 'failed') {
      throw httpError('This EFT request was cancelled/failed. Create a new request.', 400);
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const account = await this.ensureAccount(pending.client_id);
      account.purchased_credit_balance = Number(
        (Number(account.purchased_credit_balance || 0) + Number(pending.credits || 0)).toFixed(4)
      );
      syncTotalBalance(account);
      await account.save({ session });

      pending.status = 'success';
      pending.metadata = {
        ...(pending.metadata && typeof pending.metadata === 'object' ? pending.metadata : {}),
        confirmedBy: String(confirmedBy || '').trim() || 'admin',
        confirmedAt: new Date().toISOString(),
        confirmNote: String(note || '').trim().slice(0, 500),
        awaitingConfirmation: false,
        invoiceStatus: 'paid',
        pool: 'purchased',
      };
      if (!pending.metadata.invoiceNumber) {
        const BillingDocumentsService = require('../../helpers/BillingDocumentsService');
        await BillingDocumentsService.assignInvoiceToTransaction(pending);
        pending.metadata.invoiceStatus = 'paid';
      }
      await pending.save({ session });

      await session.commitTransaction();
      return { alreadyConfirmed: false, transaction: pending, account };
    } catch (e) {
      await session.abortTransaction();
      throw e;
    } finally {
      session.endSession();
    }
  }

  static async cancelEftTopup({ reference, clientId = '', cancelledBy = '' } = {}) {
    const ref = String(reference || '').trim();
    const q = { reference: ref, type: 'topup', method: 'eft', status: 'pending' };
    if (clientId) q.client_id = String(clientId).trim();
    const pending = await SaasTransaction.findOne(q);
    if (!pending) throw httpError('Pending EFT request not found', 404);
    pending.status = 'failed';
    pending.metadata = {
      ...(pending.metadata && typeof pending.metadata === 'object' ? pending.metadata : {}),
      cancelledBy: String(cancelledBy || '').trim() || 'user',
      cancelledAt: new Date().toISOString(),
      awaitingConfirmation: false,
    };
    await pending.save();
    return pending;
  }

  static async markEftPaidByClient({ reference, clientId, note = '' } = {}) {
    const ref = String(reference || '').trim();
    const pending = await SaasTransaction.findOne({
      reference: ref,
      client_id: String(clientId).trim(),
      type: 'topup',
      method: 'eft',
      status: 'pending',
    });
    if (!pending) throw httpError('Pending EFT request not found', 404);
    pending.metadata = {
      ...(pending.metadata && typeof pending.metadata === 'object' ? pending.metadata : {}),
      clientMarkedPaidAt: new Date().toISOString(),
      clientNote: String(note || '').trim().slice(0, 500),
    };
    await pending.save();
    return pending;
  }

  /**
   * Hard gate before WhatsApp sends or Meta ads create/boost.
   */
  static async assertCreditsForAction(clientId, service, messageType = 'service', units = 1) {
    const id = String(clientId || '').trim();
    if (!id || id === 'Khana') {
      return { ok: true, need: 0, balance: null, exempt: true };
    }

    await this.ensureMonthlyIncludedCredits(id);

    const client = await Client.findOne({ clientID: id }).select('tier').lean();
    const tier = client?.tier || 'bronze';
    let need = 1;
    try {
      if (service === 'whatsapp') {
        const priced = await PricingService.computeWhatsAppCredits(id, messageType, units);
        need = Number(priced.credits || 1) || 1;
      } else {
        const rule = await PricingService.getActiveRule(service, messageType, tier);
        need = PricingService.computeCredits(rule, units);
      }
    } catch (err) {
      if (service === 'ads_service_fee') need = Math.max(1, Number(units) || 1) * 5;
      else throw err;
    }

    const account = await this.ensureAccount(id);
    const balance = Number(account.credit_balance || 0) || 0;
    if (balance < need) {
      const packs = listCreditPacks()
        .slice(0, 3)
        .map((p) => `${p.name} R${p.zar}→${p.credits} credits`)
        .join('; ');
      throw httpError(
        `Insufficient Khana credits (need ${need}, have ${balance}). ` +
          `Your monthly included credits may be used up — top up a prepaid pack for more. ` +
          `Examples: ${packs}.`,
        402
      );
    }

    return { ok: true, need, balance, exempt: false };
  }

  static async topUpCredits({ clientId, credits, amount, method = 'payfast', reference, metadata = {} }) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const account = await this.ensureAccount(clientId);
      const add = Number(credits || 0);
      account.purchased_credit_balance = Number(
        (Number(account.purchased_credit_balance || 0) + add).toFixed(4)
      );
      syncTotalBalance(account);
      await account.save({ session });

      const txn = await SaasTransaction.create(
        [
          {
            client_id: clientId,
            type: 'topup',
            amount: Number(amount || credits || 0),
            credits: add,
            method,
            reference,
            status: 'success',
            metadata: { ...metadata, pool: 'purchased' },
          },
        ],
        { session }
      );

      await session.commitTransaction();
      return { account, transaction: txn[0] };
    } catch (e) {
      await session.abortTransaction();
      throw e;
    } finally {
      session.endSession();
    }
  }

  /** Manual top-up that prefers pack pricing when pack_id is supplied. */
  static async topUpWithPack({ clientId, packId, amount, reference, method = 'manual', metadata = {} }) {
    const pack = getCreditPack(packId);
    const zar = Number(amount || pack?.zar || 0);
    const awarded = creditsForTopupPayment({
      amountZar: zar,
      packId: packId || '',
      preferSpot: !packId,
    });
    return this.topUpCredits({
      clientId,
      credits: awarded.credits,
      amount: zar,
      method,
      reference: reference || `pack-${awarded.packId || 'spot'}-${Date.now()}`,
      metadata: {
        ...metadata,
        packId: awarded.packId || null,
        rateLabel: awarded.rateLabel,
        zarPerCredit: awarded.zarPerCredit,
        hint: prepaidCheaperHint(),
        pool: 'purchased',
      },
    });
  }

  static async chargeUsage({ clientId, service, messageType, units = 1, sourceRef, metadata = {} }) {
    const client = await Client.findOne({ clientID: clientId }).select('tier subscription').lean();
    const tier = client?.tier || 'bronze';
    const rule = await PricingService.getActiveRule(service, messageType, tier);

    let creditsToDeduct = PricingService.computeCredits(rule, units);
    let volumeMeta = {};
    if (service === 'whatsapp') {
      const priced = await PricingService.computeWhatsAppCredits(clientId, messageType, units, rule);
      creditsToDeduct = priced.credits;
      volumeMeta = {
        volumeApplied: priced.volumeApplied,
        monthCountBefore: priced.monthCount,
        unitRate: priced.unitRate,
      };
    }

    if (clientId === 'Khana') {
      const account = await this.ensureAccount(clientId);
      const txn = await SaasTransaction.create({
        client_id: clientId,
        type: 'deduction',
        amount: 0,
        credits: 0,
        method: 'internal',
        reference: sourceRef,
        status: 'success',
        metadata: {
          ...metadata,
          service,
          messageType,
          units,
          pricingRuleId: rule ? String(rule._id) : null,
          clientTier: tier,
          platformExempt: true,
          listCredits: creditsToDeduct,
          ...volumeMeta,
        },
      });
      return { account, transaction: txn, rule, deductedCredits: 0 };
    }

    await this.ensureMonthlyIncludedCredits(clientId);

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const account = await this.ensureAccount(clientId);
      if (account.credit_balance < creditsToDeduct) {
        throw new Error('Insufficient credits');
      }

      const pools = applyDeductionToPools(account, creditsToDeduct);
      account.total_spent = Number((account.total_spent + creditsToDeduct).toFixed(4));
      await account.save({ session });

      const txn = await SaasTransaction.create(
        [
          {
            client_id: clientId,
            type: 'deduction',
            amount: creditsToDeduct,
            credits: creditsToDeduct,
            method: 'internal',
            reference: sourceRef,
            status: 'success',
            metadata: {
              ...metadata,
              service,
              messageType,
              units,
              pricingRuleId: String(rule._id),
              clientTier: tier,
              fromIncluded: pools.fromIncluded,
              fromPurchased: pools.fromPurchased,
              ...volumeMeta,
            },
          },
        ],
        { session }
      );

      await session.commitTransaction();
      return { account, transaction: txn[0], rule, deductedCredits: creditsToDeduct };
    } catch (e) {
      await session.abortTransaction();
      throw e;
    } finally {
      session.endSession();
    }
  }
}

module.exports = BillingService;
