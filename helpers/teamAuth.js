const jwt = require('jsonwebtoken');
const Client = require('../models/client');
const TeamMember = require('../models/teamMember');
const { verifyJwtWithAnySecret, getJwtSecret } = require('./jwtSecret');
const { canManageTeam, fullPermissions, applyClientFeatureAccess } = require('./teamPermissions');

function signTeamSessionToken(client, member, options = {}) {
  const payload = {
    clientID: client.clientID,
    merchant_id: client.merchant_id,
    isActive: true,
    loginType: options.loginType || 'team',
  };

  if (member) {
    payload.memberId = String(member._id);
    payload.orgRole = member.orgRole;
  }

  return jwt.sign(payload, getJwtSecret(), { expiresIn: '1d' });
}

async function resolveSessionFromToken(decoded) {
  const client = await Client.findOne({ clientID: decoded.clientID });
  if (!client) return null;

  const platformAdmin = client.role === 'admin';

  if (decoded.memberId) {
    const member = await TeamMember.findById(decoded.memberId);
    if (!member || member.clientID !== client.clientID || member.status !== 'active') {
      return null;
    }
    const permissions = applyClientFeatureAccess(member.permissions, client);
    // Do NOT grant team management just because the tenant is the platform-admin client.
    // Only owner/admin org roles can manage Team; view-only members never can.
    const manageTeam = canManageTeam(member.orgRole) && !permissions.readOnly;
    return {
      client,
      member,
      platformAdmin: platformAdmin && member.orgRole === 'owner',
      orgRole: member.orgRole,
      permissions,
      canManageTeam: manageTeam,
    };
  }

  if (platformAdmin) {
    return {
      client,
      member: null,
      platformAdmin: true,
      orgRole: 'owner',
      permissions: fullPermissions(),
      canManageTeam: true,
    };
  }

  // Storefront / integration JWT (client.token) — not a team member session
  if (decoded.loginType !== 'team') {
    const { permissionsFromClient } = require('./teamPermissions');
    return {
      client,
      member: null,
      platformAdmin: false,
      orgRole: null,
      permissions: permissionsFromClient(client),
      canManageTeam: false,
      isApiToken: true,
    };
  }

  // Dashboard team JWT must include a member
  return null;
}

function requireTeamSession() {
  return async (req, res, next) => {
    try {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const token = auth.split(' ')[1];
      const { decoded } = verifyJwtWithAnySecret(jwt, token);
      const session = await resolveSessionFromToken(decoded);
      if (!session) {
        return res.status(401).json({ error: 'Invalid or expired session' });
      }

      req.teamSession = session;
      req.clientID = session.client.clientID;
      req.user = decoded;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  };
}

function requireTeamManager() {
  return (req, res, next) => {
    if (!req.teamSession?.canManageTeam) {
      return res.status(403).json({ error: 'Team management access required' });
    }
    if (req.teamSession.permissions?.readOnly) {
      return res.status(403).json({
        error: 'This account is view-only. Team permissions can only be changed by an organization admin.',
        code: 'READ_ONLY',
      });
    }
    next();
  };
}

module.exports = {
  signTeamSessionToken,
  resolveSessionFromToken,
  requireTeamSession,
  requireTeamManager,
};
