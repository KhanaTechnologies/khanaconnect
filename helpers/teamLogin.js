const bcrypt = require('bcryptjs');
const Client = require('../models/client');
const TeamMember = require('../models/teamMember');
const { signTeamSessionToken } = require('./teamAuth');
const { fullPermissions, permissionsFromClient, applyClientFeatureAccess } = require('./teamPermissions');
const { normalizeTeamEmail, findTeamMemberByEmail } = require('./teamMemberLookup');
const {
  serializeSubscriptionSummary,
  isClientSubscriptionActive,
} = require('./clientSubscription');

async function ensureOwnerMember(client, email, passwordHash) {
  const existingOwner = await TeamMember.findOne({ clientID: client.clientID, orgRole: 'owner' });
  if (existingOwner) return existingOwner;

  const ownerEmail = normalizeTeamEmail(email || client.businessEmail || `${client.clientID}@owner.local`);

  return TeamMember.create({
    clientID: client.clientID,
    email: ownerEmail,
    firstName: client.companyName || 'Owner',
    lastName: '',
    passwordHash,
    orgRole: 'owner',
    permissions: fullPermissions(),
    status: 'active',
  });
}

function buildLoginResponse(client, member, token) {
  const clientResponse = client.toObject();
  delete clientResponse.password;
  delete clientResponse.token;
  delete clientResponse.businessEmailPassword;

  const permissions = member
    ? applyClientFeatureAccess(member.permissions, client)
    : client.role === 'admin'
      ? fullPermissions()
      : permissionsFromClient(client);

  // Client.role === 'admin' means the *tenant* is the Khana platform account.
  // Only the org owner (or password-only platform login) should receive platform-admin FE powers.
  // Other team members on that tenant must stay "client" or they can open Team / Permissions.
  const platformAdminSession =
    client.role === 'admin' && (!member || member.orgRole === 'owner');

  const canManageTeam = member
    ? ['owner', 'admin', 'manager'].includes(member.orgRole) && !permissions.readOnly
    : platformAdminSession;

  return {
    success: true,
    client: clientResponse,
    member: member ? member.toJSON() : null,
    token,
    permissions: {
      ...permissions,
      hasDashboardAccess: permissions.dashboard !== false,
    },
    role: platformAdminSession ? 'admin' : 'client',
    orgRole: member?.orgRole || null,
    tier: client.tier,
    email: member?.email || null,
    name: member?.displayName || client.companyName,
    companyName: client.companyName || client.clientID,
    dashboardThemeColor: client.dashboardThemeColor || '',
    canManageTeam,
    hasAdPlatforms: client.hasEnabledAdPlatforms,
    enabledAdPlatforms: client.getEnabledAdPlatforms(),
    subscription: serializeSubscriptionSummary(client),
    subscriptionActive: isClientSubscriptionActive(client),
  };
}

async function authenticateClientLogin({ clientID, email, password }) {
  const client = await Client.findOne({ clientID });
  if (!client) {
    return { ok: false, status: 400, message: 'Invalid client ID, email, or password' };
  }

  const normalizedEmail = normalizeTeamEmail(email);
  const passwordValue = String(password || '');

  if (!passwordValue) {
    return { ok: false, status: 400, message: 'Password is required' };
  }

  // Khana platform admin may sign in with client ID + password only
  if (!normalizedEmail && client.role === 'admin') {
    if (!bcrypt.compareSync(passwordValue, client.password)) {
      return { ok: false, status: 400, message: 'Invalid client ID, email, or password' };
    }

    const token = signTeamSessionToken(client, null, { loginType: 'platform_admin' });
    client.sessionToken = token;
    client.sessionExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    client.isLoggedIn = true;
    await client.save();

    return { ok: true, body: buildLoginResponse(client, null, token) };
  }

  if (!normalizedEmail) {
    return { ok: false, status: 400, message: 'Email is required' };
  }

  let member = await findTeamMemberByEmail(client.clientID, normalizedEmail, {
    selectPasswordHash: true,
  });

  if (member) {
    if (member.status === 'disabled') {
      return { ok: false, status: 403, message: 'This account has been disabled' };
    }
    if (member.status === 'invited') {
      return {
        ok: false,
        status: 403,
        message: 'Please accept your invite email and set a password before signing in.',
      };
    }
    if (!bcrypt.compareSync(passwordValue, member.passwordHash)) {
      return { ok: false, status: 400, message: 'Invalid client ID, email, or password' };
    }
  } else {
    return { ok: false, status: 400, message: 'Invalid client ID, email, or password' };
  }

  member.lastLoginAt = new Date();
  member.status = 'active';
  await member.save();

  const token = signTeamSessionToken(client, member);
  client.sessionToken = token;
  client.sessionExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  client.isLoggedIn = true;
  await client.save();

  const freshMember = await TeamMember.findById(member._id);
  return { ok: true, body: buildLoginResponse(client, freshMember, token) };
}

module.exports = {
  authenticateClientLogin,
  ensureOwnerMember,
  buildLoginResponse,
  permissionsFromClient,
};
