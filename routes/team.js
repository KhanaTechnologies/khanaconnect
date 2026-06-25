const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const TeamMember = require('../models/teamMember');
const Client = require('../models/client');
const { wrapRoute } = require('../helpers/failureEmail');
const { requireTeamSession, requireTeamManager } = require('../helpers/teamAuth');
const {
  normalizeTeamEmail,
  teamMemberEmailExists,
} = require('../helpers/teamMemberLookup');
const {
  normalizePermissions,
  permissionsFromClient,
} = require('../helpers/teamPermissions');
const {
  changeTeamMemberLoginEmail,
  changeTeamMemberPassword,
} = require('../helpers/teamMemberEmail');
const {
  requestTeamPasswordReset,
  completeTeamPasswordReset,
} = require('../helpers/teamPasswordReset');
const {
  issueTeamInvite,
  resendTeamInvite,
  getTeamInvitePreview,
  completeTeamInvite,
} = require('../helpers/teamInvite');
const {
  listPermissionPresets,
  resolveNewMemberPermissions,
} = require('../helpers/teamPermissionPresets');
const { getTeamSeatUsage, assertTeamSeatAvailable } = require('../helpers/teamSeats');
const { normalizeDashboardThemeColor } = require('../helpers/dashboardTheme');
const {
  ACTIVITY_CATEGORIES,
  getTeamActivitySettings,
  updateTeamActivitySettings,
  listTeamActivity,
  recordTeamActivityFromRequest,
} = require('../helpers/teamActivity');

const router = express.Router();

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many reset attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function sanitizeMember(member) {
  const json = member.toJSON ? member.toJSON() : member;
  delete json.passwordHash;
  return json;
}

router.post('/reset-password', resetLimiter, wrapRoute(async (req, res) => {
  try {
    const result = await requestTeamPasswordReset({
      clientID: req.body.clientID,
      email: req.body.email,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to process reset request' });
  }
}));

router.post('/reset-password/:token', resetLimiter, wrapRoute(async (req, res) => {
  try {
    const result = await completeTeamPasswordReset({
      token: req.params.token,
      password: req.body.password,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to reset password' });
  }
}));

router.get('/accept-invite/:token', wrapRoute(async (req, res) => {
  try {
    const result = await getTeamInvitePreview({ token: req.params.token });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Invalid invite link' });
  }
}));

router.post('/accept-invite/:token', resetLimiter, wrapRoute(async (req, res) => {
  try {
    const result = await completeTeamInvite({
      token: req.params.token,
      password: req.body.password,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to accept invite' });
  }
}));

router.use(requireTeamSession());

router.get('/permission-presets', wrapRoute(async (req, res) => {
  res.json({ success: true, presets: listPermissionPresets() });
}));

router.get('/seats', wrapRoute(async (req, res) => {
  if (!req.teamSession.canManageTeam) {
    return res.status(403).json({ error: 'Team management access required' });
  }
  const seats = await getTeamSeatUsage(req.clientID);
  res.json({ success: true, seats });
}));

router.get('/activity/categories', wrapRoute(async (req, res) => {
  res.json({ success: true, categories: ACTIVITY_CATEGORIES });
}));

router.get('/activity/settings', requireTeamManager(), wrapRoute(async (req, res) => {
  const settings = await getTeamActivitySettings(req.clientID);
  res.json({ success: true, settings, categories: ACTIVITY_CATEGORIES });
}));

router.put('/activity/settings', requireTeamManager(), wrapRoute(async (req, res) => {
  const settings = await updateTeamActivitySettings(req.clientID, req.body || {});
  res.json({ success: true, message: 'Activity preferences saved', settings });
}));

router.get('/activity', requireTeamManager(), wrapRoute(async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const skip = parseInt(req.query.skip, 10) || 0;
  const category = req.query.category || undefined;
  const result = await listTeamActivity(req.clientID, { limit, skip, category });
  res.json({ success: true, ...result });
}));

router.get('/members', wrapRoute(async (req, res) => {
  if (!req.teamSession.canManageTeam) {
    return res.status(403).json({ error: 'Team management access required' });
  }

  const [members, seats] = await Promise.all([
    TeamMember.find({ clientID: req.clientID }).sort({ orgRole: 1, createdAt: 1 }),
    getTeamSeatUsage(req.clientID),
  ]);
  res.json({
    success: true,
    clientID: req.clientID,
    members: members.map(sanitizeMember),
    seats,
  });
}));

router.get('/me', wrapRoute(async (req, res) => {
  const { client, member, permissions, orgRole, canManageTeam: manageTeam } = req.teamSession;
  res.json({
    success: true,
    clientID: client.clientID,
    companyName: client.companyName,
    dashboardThemeColor: client.dashboardThemeColor || '',
    emailLogoUrl: client.emailLogoUrl || '',
    member: member ? sanitizeMember(member) : null,
    orgRole,
    permissions,
    canManageTeam: manageTeam,
  });
}));

router.put('/me/dashboard-theme', requireTeamManager(), wrapRoute(async (req, res) => {
  const normalized = normalizeDashboardThemeColor(req.body?.color);
  if (req.body?.color != null && req.body?.color !== '' && normalized === null) {
    return res.status(400).json({ error: 'Invalid color. Use a hex value like #3b6fc9.' });
  }

  const color = normalized ?? '';
  await Client.updateOne({ clientID: req.clientID }, { $set: { dashboardThemeColor: color } });

  res.json({
    success: true,
    message: color ? 'Dashboard theme updated' : 'Dashboard theme reset to default',
    dashboardThemeColor: color,
  });
}));

router.put('/me/login-email', wrapRoute(async (req, res) => {
  const sessionMember = req.teamSession.member;
  if (!sessionMember) {
    return res.status(403).json({ error: 'A team member session is required to change login email' });
  }

  const { newEmail, currentPassword } = req.body;
  if (!currentPassword) {
    return res.status(400).json({ error: 'Current password is required to change your login email' });
  }

  const member = await TeamMember.findById(sessionMember._id).select('+passwordHash');
  if (!member || member.clientID !== req.clientID) {
    return res.status(404).json({ error: 'Team member not found' });
  }

  if (!bcrypt.compareSync(String(currentPassword), member.passwordHash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }

  try {
    const updated = await changeTeamMemberLoginEmail({
      clientID: req.clientID,
      memberId: member._id,
      newEmail,
    });
    res.json({
      success: true,
      message: 'Login email updated',
      member: sanitizeMember(updated),
      email: updated.email,
    });
    recordTeamActivityFromRequest(req, {
      category: 'account',
      action: 'login_email.changed',
      summary: `Login email changed to ${updated.email}`,
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Failed to update login email' });
  }
}));

router.put('/me/password', wrapRoute(async (req, res) => {
  const sessionMember = req.teamSession.member;
  if (!sessionMember) {
    return res.status(403).json({ error: 'A team member session is required to change password' });
  }

  const { currentPassword, newPassword } = req.body;
  try {
    const updated = await changeTeamMemberPassword({
      clientID: req.clientID,
      memberId: sessionMember._id,
      currentPassword,
      newPassword,
    });
    res.json({ success: true, message: 'Password updated', member: sanitizeMember(updated) });
    recordTeamActivityFromRequest(req, {
      category: 'account',
      action: 'password.changed',
      summary: 'Dashboard password was changed',
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Failed to update password' });
  }
}));

router.post('/members/invite', requireTeamManager(), wrapRoute(async (req, res) => {
  const {
    email,
    firstName,
    lastName,
    orgRole = 'member',
    permissions,
    presetId,
    copyFromMemberId,
  } = req.body;

  try {
    const result = await issueTeamInvite({
      clientID: req.clientID,
      email,
      firstName,
      lastName,
      orgRole,
      permissions,
      presetId,
      copyFromMemberId,
      invitedBy: req.teamSession.member?._id || null,
    });
    res.status(201).json({
      success: true,
      message: result.message,
      member: sanitizeMember(result.member),
    });
    recordTeamActivityFromRequest(req, {
      category: 'team',
      action: 'member.invited',
      summary: `Invite sent to ${result.member.email}`,
      metadata: { memberId: result.member._id, orgRole: result.member.orgRole },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to send invite' });
  }
}));

router.post('/members/:id/resend-invite', requireTeamManager(), wrapRoute(async (req, res) => {
  try {
    const result = await resendTeamInvite({
      clientID: req.clientID,
      memberId: req.params.id,
    });
    res.json(result);
    recordTeamActivityFromRequest(req, {
      category: 'team',
      action: 'member.invite_resent',
      summary: 'Invite resent to team member',
      metadata: { memberId: req.params.id },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to resend invite' });
  }
}));

router.post('/members', requireTeamManager(), wrapRoute(async (req, res) => {
  const {
    email,
    password,
    firstName,
    lastName,
    orgRole = 'member',
    permissions,
    presetId,
    copyFromMemberId,
  } = req.body;

  const normalizedEmail = normalizeTeamEmail(email);
  if (!normalizedEmail || !password || String(password).length < 6) {
    return res.status(400).json({ error: 'Email and password (min 6 characters) are required' });
  }

  if (orgRole === 'owner') {
    return res.status(400).json({ error: 'Cannot create another owner. Transfer ownership is not available in phase 1.' });
  }

  const existing = await teamMemberEmailExists(req.clientID, normalizedEmail);
  if (existing) {
    return res.status(409).json({ error: 'A team member with this email already exists' });
  }

  try {
    await assertTeamSeatAvailable(req.clientID);
  } catch (err) {
    return res.status(err.status || 403).json({ error: err.message, seats: err.seatUsage });
  }

  const client = await Client.findOne({ clientID: req.clientID });

  let copyFromMember = null;
  if (copyFromMemberId) {
    copyFromMember = await TeamMember.findOne({
      _id: copyFromMemberId,
      clientID: req.clientID,
    });
    if (!copyFromMember) {
      return res.status(400).json({ error: 'copyFromMemberId is not a valid team member' });
    }
  }

  const memberPermissions = permissions
    ? normalizePermissions(permissions)
    : resolveNewMemberPermissions({ presetId, copyFromMember, client });

  const member = await TeamMember.create({
    clientID: req.clientID,
    email: normalizedEmail,
    firstName: firstName || '',
    lastName: lastName || '',
    passwordHash: bcrypt.hashSync(password, 10),
    orgRole: ['admin', 'manager', 'member'].includes(orgRole) ? orgRole : 'member',
    permissions: memberPermissions,
    status: 'active',
    invitedBy: req.teamSession.member?._id || null,
  });

  res.status(201).json({
    success: true,
    message: 'Team member created',
    member: sanitizeMember(member),
  });
  recordTeamActivityFromRequest(req, {
    category: 'team',
    action: 'member.created',
    summary: `Team member added: ${member.email}`,
    metadata: { memberId: member._id, orgRole: member.orgRole },
  });
}));

router.put('/members/:id', requireTeamManager(), wrapRoute(async (req, res) => {
  const member = await TeamMember.findOne({ _id: req.params.id, clientID: req.clientID });
  if (!member) return res.status(404).json({ error: 'Team member not found' });

  if (member.orgRole === 'owner' && req.teamSession.member?.orgRole !== 'owner' && !req.teamSession.platformAdmin) {
    return res.status(403).json({ error: 'Only the owner can update the owner account' });
  }

  const { firstName, lastName, orgRole, status, password } = req.body;

  if (typeof firstName === 'string') member.firstName = firstName;
  if (typeof lastName === 'string') member.lastName = lastName;

  if (orgRole && member.orgRole !== 'owner') {
    if (!['admin', 'manager', 'member'].includes(orgRole)) {
      return res.status(400).json({ error: 'Invalid org role' });
    }
    member.orgRole = orgRole;
  }

  if (status && member.orgRole !== 'owner') {
    if (!['active', 'disabled', 'invited'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    member.status = status;
  }

  if (password && String(password).length >= 6) {
    member.passwordHash = bcrypt.hashSync(password, 10);
  }

  await member.save();
  res.json({ success: true, member: sanitizeMember(member) });
}));

router.put('/members/:id/permissions', requireTeamManager(), wrapRoute(async (req, res) => {
  const member = await TeamMember.findOne({ _id: req.params.id, clientID: req.clientID });
  if (!member) return res.status(404).json({ error: 'Team member not found' });

  if (member.orgRole === 'owner') {
    return res.status(400).json({ error: 'Owner permissions cannot be changed' });
  }

  if (!req.body.permissions || typeof req.body.permissions !== 'object') {
    return res.status(400).json({ error: 'permissions object is required' });
  }

  member.permissions = normalizePermissions({
    ...member.permissions?.toObject?.() || member.permissions,
    ...req.body.permissions,
  });
  await member.save();

  res.json({
    success: true,
    message: 'Permissions updated',
    member: sanitizeMember(member),
  });
  recordTeamActivityFromRequest(req, {
    category: 'team',
    action: 'member.permissions_updated',
    summary: `Permissions updated for ${member.email}`,
    metadata: { memberId: member._id },
  });
}));

router.delete('/members/:id', requireTeamManager(), wrapRoute(async (req, res) => {
  const member = await TeamMember.findOne({ _id: req.params.id, clientID: req.clientID });
  if (!member) return res.status(404).json({ error: 'Team member not found' });

  if (member.orgRole === 'owner') {
    return res.status(400).json({ error: 'Cannot remove the organization owner' });
  }

  if (String(req.teamSession.member?._id) === String(member._id)) {
    return res.status(400).json({ error: 'You cannot remove your own account' });
  }

  const removedEmail = member.email;
  await TeamMember.deleteOne({ _id: member._id });
  res.json({ success: true, message: 'Team member removed' });
  recordTeamActivityFromRequest(req, {
    category: 'team',
    action: 'member.removed',
    summary: `Team member removed: ${removedEmail}`,
    metadata: { memberId: member._id },
  });
}));

module.exports = router;
