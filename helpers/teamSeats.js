const Client = require('../models/client');
const TeamMember = require('../models/teamMember');

const TIER_SEAT_LIMITS = {
  bronze: Number(process.env.TIER_BRONZE_TEAM_SEATS || 2),
  silver: Number(process.env.TIER_SILVER_TEAM_SEATS || 5),
  gold: Number(process.env.TIER_GOLD_TEAM_SEATS || 10),
};

const TIER_LABELS = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
};

function seatLimitForClient(client) {
  if (!client) return TIER_SEAT_LIMITS.bronze;
  if (client.role === 'admin') return 999;
  return TIER_SEAT_LIMITS[client.tier] ?? TIER_SEAT_LIMITS.bronze;
}

async function getTeamSeatUsage(clientID) {
  const client = await Client.findOne({ clientID }).select('tier role companyName');
  const limit = seatLimitForClient(client);
  const used = await TeamMember.countDocuments({
    clientID,
    status: { $in: ['active', 'invited'] },
  });

  return {
    clientID,
    tier: client?.tier || 'bronze',
    tierLabel: TIER_LABELS[client?.tier] || 'Bronze',
    used,
    limit: limit >= 999 ? null : limit,
    unlimited: limit >= 999,
    remaining: limit >= 999 ? null : Math.max(0, limit - used),
    atLimit: limit < 999 && used >= limit,
  };
}

async function assertTeamSeatAvailable(clientID) {
  const usage = await getTeamSeatUsage(clientID);
  if (usage.atLimit) {
    const err = new Error(
      `Team seat limit reached (${usage.used}/${usage.limit} on ${usage.tierLabel} plan). ` +
        'Remove a member or upgrade your plan to add more users.'
    );
    err.status = 403;
    err.seatUsage = usage;
    throw err;
  }
  return usage;
}

module.exports = {
  TIER_SEAT_LIMITS,
  TIER_LABELS,
  getTeamSeatUsage,
  assertTeamSeatAvailable,
};
