const Client = require('../models/client');
const TeamMember = require('../models/teamMember');
const {
  UNLIMITED_SEATS,
  loadPlanBuilder,
  seatLimitForClient,
  planIdForClient,
  planLabel,
  includedSeatsForPlan,
  extraSeatsForClient,
} = require('./clientPlan');

/**
 * Team seats follow the client's plan (subscription.plan): the plan's included seats
 * (Website Pricing → plan builder, defaults Starter 1 · Launch 1 · Growth 3 · Scale 5 · Enterprise 10)
 * plus subscription.extraSeats the client pays for. The owner counts as a seat.
 */
async function getTeamSeatUsage(clientID) {
  const [client, planBuilder, used] = await Promise.all([
    Client.findOne({ clientID }).select('subscription role companyName').lean(),
    loadPlanBuilder(),
    TeamMember.countDocuments({
      clientID,
      status: { $in: ['active', 'invited'] },
    }),
  ]);
  const limit = seatLimitForClient(client, planBuilder);
  const unlimited = limit >= UNLIMITED_SEATS;
  const plan = planIdForClient(client);

  return {
    clientID,
    plan,
    planLabel: planLabel(plan),
    // Kept for older dashboard builds: these now carry the plan, not the retired metal tiers.
    tier: plan,
    tierLabel: planLabel(plan),
    includedSeats: unlimited ? null : includedSeatsForPlan(plan, planBuilder),
    extraSeats: unlimited ? 0 : extraSeatsForClient(client),
    extraSeatMonthlyFee: planBuilder.extraSeatMonthlyFee,
    used,
    limit: unlimited ? null : limit,
    unlimited,
    remaining: unlimited ? null : Math.max(0, limit - used),
    atLimit: !unlimited && used >= limit,
  };
}

async function assertTeamSeatAvailable(clientID) {
  const usage = await getTeamSeatUsage(clientID);
  if (usage.atLimit) {
    const err = new Error(
      `Team seat limit reached (${usage.used}/${usage.limit} on the ${usage.planLabel} plan). ` +
        'Remove a member, or ask us to add an extra seat or move you to a bigger plan.'
    );
    err.status = 403;
    err.seatUsage = usage;
    throw err;
  }
  return usage;
}

module.exports = {
  getTeamSeatUsage,
  assertTeamSeatAvailable,
};
