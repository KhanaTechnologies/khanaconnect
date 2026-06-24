const Client = require('../models/client');
const TeamMember = require('../models/teamMember');
const TeamActivity = require('../models/TeamActivity');
const { mergeTeamActivitySettings, ACTIVITY_CATEGORIES } = require('./teamActivityDefaults');
const { getKhanaAdminClient, getDashboardBaseUrl } = require('./teamPasswordReset');
const { sendTeamActivityNotifyEmail } = require('../utils/email');

function actorLabelFromSession(teamSession) {
  if (!teamSession?.member) {
    if (teamSession?.platformAdmin) return 'Khana admin';
    return 'System';
  }
  const m = teamSession.member;
  return m.displayName || `${m.firstName || ''} ${m.lastName || ''}`.trim() || m.email || 'Team member';
}

async function getTeamActivitySettings(clientID) {
  const client = await Client.findOne({ clientID }).select('teamActivitySettings');
  return mergeTeamActivitySettings(client);
}

async function updateTeamActivitySettings(clientID, payload) {
  const current = await getTeamActivitySettings(clientID);
  const next = {
    logCategories: { ...current.logCategories },
    notifyCategories: { ...current.notifyCategories },
  };

  if (payload.logCategories && typeof payload.logCategories === 'object') {
    for (const [key, value] of Object.entries(payload.logCategories)) {
      if (typeof value === 'boolean' && key in next.logCategories) {
        next.logCategories[key] = value;
      }
    }
  }

  if (payload.notifyCategories && typeof payload.notifyCategories === 'object') {
    for (const [key, value] of Object.entries(payload.notifyCategories)) {
      if (typeof value === 'boolean' && key in next.notifyCategories) {
        next.notifyCategories[key] = value;
      }
    }
  }

  await Client.updateOne(
    { clientID },
    { $set: { teamActivitySettings: next } }
  );

  return next;
}

async function listTeamActivity(clientID, { limit = 50, skip = 0, category } = {}) {
  const query = { clientID };
  if (category) query.category = category;

  const [items, total] = await Promise.all([
    TeamActivity.find(query).sort({ createdAt: -1 }).skip(skip).limit(Math.min(limit, 100)).lean(),
    TeamActivity.countDocuments(query),
  ]);

  return { items, total, limit, skip };
}

async function notifyOwnerIfEnabled({ client, category, summary, settings }) {
  if (!settings.notifyCategories[category]) return;

  const owner = await TeamMember.findOne({
    clientID: client.clientID,
    orgRole: 'owner',
    status: 'active',
  });

  if (!owner?.email) return;

  try {
    const admin = await getKhanaAdminClient();
    const activityUrl = `${getDashboardBaseUrl()}/dashboard/activity`;

    await sendTeamActivityNotifyEmail({
      ownerEmail: owner.email,
      ownerName: owner.displayName || owner.firstName || owner.email,
      companyName: client.companyName || client.clientID,
      clientID: client.clientID,
      categoryLabel: ACTIVITY_CATEGORIES.find((c) => c.id === category)?.label || category,
      summary,
      activityUrl,
      adminBusinessEmail: admin.businessEmail,
      adminBusinessEmailPassword: admin.businessEmailPassword,
      adminCompanyName: admin.companyName,
      emailSignature: admin.emailSignature || '',
      adminClientId: admin.clientID,
    });
  } catch (err) {
    console.error('[teamActivity] Owner notify failed:', err.message);
  }
}

/**
 * Record dashboard activity (non-blocking — call without await or use .catch()).
 */
async function recordTeamActivity({
  clientID,
  category,
  action,
  summary,
  teamSession = null,
  metadata = {},
}) {
  if (!clientID || !category || !summary) return null;

  const client = await Client.findOne({ clientID }).select('companyName teamActivitySettings role');
  if (!client) return null;

  const settings = mergeTeamActivitySettings(client);
  if (!settings.logCategories[category]) return null;

  const entry = await TeamActivity.create({
    clientID,
    category,
    action,
    summary,
    actorMemberId: teamSession?.member?._id || null,
    actorLabel: actorLabelFromSession(teamSession),
    metadata,
  });

  notifyOwnerIfEnabled({ client, category, summary, settings }).catch((err) => {
    console.error('[teamActivity] notify error:', err.message);
  });

  return entry;
}

function recordTeamActivityFromRequest(req, payload) {
  const clientID = req.clientID || req.clientId || req.teamSession?.client?.clientID;
  if (!clientID) return Promise.resolve(null);

  return recordTeamActivity({
    ...payload,
    clientID,
    teamSession: req.teamSession || null,
  }).catch((err) => {
    console.error('[teamActivity] record failed:', err.message);
    return null;
  });
}

module.exports = {
  ACTIVITY_CATEGORIES,
  getTeamActivitySettings,
  updateTeamActivitySettings,
  listTeamActivity,
  recordTeamActivity,
  recordTeamActivityFromRequest,
};
