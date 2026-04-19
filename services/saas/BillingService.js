const mongoose = require('mongoose');
const Client = require('../../models/Client');
const SaasBillingAccount = require('../../models/SaasBillingAccount');
const SaasTransaction = require('../../models/SaasTransaction');
const PricingService = require('./PricingService');

class BillingService {
  static async ensureAccount(clientId) {
    let acct = await SaasBillingAccount.findOne({ client_id: clientId });
    if (!acct) {
      acct = await SaasBillingAccount.create({ client_id: clientId });
    }
    return acct;
  }

  static async topUpCredits({ clientId, credits, amount, method = 'payfast', reference, metadata = {} }) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const account = await this.ensureAccount(clientId);
      account.credit_balance += Number(credits || 0);
      await account.save({ session });

      const txn = await SaasTransaction.create(
        [
          {
            client_id: clientId,
            type: 'topup',
            amount: Number(amount || credits || 0),
            credits: Number(credits || 0),
            method,
            reference,
            status: 'success',
            metadata,
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

  static async chargeUsage({ clientId, service, messageType, units = 1, sourceRef, metadata = {} }) {
    const client = await Client.findOne({ clientID: clientId }).select('tier').lean();
    const tier = client?.tier || 'bronze';
    const rule = await PricingService.getActiveRule(service, messageType, tier);
    const creditsToDeduct = PricingService.computeCredits(rule, units);

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const account = await this.ensureAccount(clientId);
      if (account.credit_balance < creditsToDeduct) {
        throw new Error('Insufficient credits');
      }

      account.credit_balance = Number((account.credit_balance - creditsToDeduct).toFixed(4));
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
            metadata: { ...metadata, service, messageType, units, pricingRuleId: String(rule._id), clientTier: tier },
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
