const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Client = require('../models/client');
const TeamMember = require('../models/teamMember');
const { normalizeTeamEmail, teamMemberEmailExists } = require('./teamMemberLookup');
const { normalizePermissions } = require('./teamPermissions');
const { resolveNewMemberPermissions } = require('./teamPermissionPresets');
const { getKhanaAdminClient, getDashboardBaseUrl } = require('./teamPasswordReset');
const { sendTeamDashboardInviteEmail } = require('../utils/email');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function unusablePasswordHash() {
  return bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
}

async function sendInviteEmail({ client, member, inviteUrl }) {
  const admin = await getKhanaAdminClient();
  const memberEmail = normalizeTeamEmail(member.email);

  console.log(
    `[teamInvite] Sending invite to ${memberEmail} for ${client.clientID} via admin mailbox`
  );

  await sendTeamDashboardInviteEmail({
    memberEmail,
    memberName: member.displayName || member.firstName || memberEmail,
    companyName: client.companyName || client.clientID,
    clientID: client.clientID,
    inviteLink: inviteUrl,
    adminBusinessEmail: admin.businessEmail,
    adminBusinessEmailPassword: admin.businessEmailPassword,
    adminCompanyName: admin.companyName,
    emailSignature: admin.emailSignature || '',
    adminClientId: admin.clientID,
  });
}

async function issueTeamInvite({
  clientID,
  email,
  firstName,
  lastName,
  orgRole = 'member',
  permissions,
  presetId,
  copyFromMemberId,
  invitedBy,
}) {
  const normalizedEmail = normalizeTeamEmail(email);
  if (!normalizedEmail) {
    throw httpError(400, 'Valid email is required');
  }

  if (orgRole === 'owner') {
    throw httpError(400, 'Cannot invite another owner. Transfer ownership is not available yet.');
  }

  const client = await Client.findOne({ clientID });
  if (!client) throw httpError(404, 'Client not found');

  if (await teamMemberEmailExists(clientID, normalizedEmail)) {
    throw httpError(409, 'A team member with this email already exists');
  }

  const { assertTeamSeatAvailable } = require('./teamSeats');
  await assertTeamSeatAvailable(clientID);

  let copyFromMember = null;
  if (copyFromMemberId) {
    copyFromMember = await TeamMember.findOne({
      _id: copyFromMemberId,
      clientID,
    });
    if (!copyFromMember) {
      throw httpError(400, 'copyFromMemberId is not a valid team member');
    }
  }

  const memberPermissions = permissions
    ? normalizePermissions(permissions)
    : resolveNewMemberPermissions({ presetId, copyFromMember, client });

  const token = crypto.randomBytes(32).toString('hex');
  const inviteUrl = `${getDashboardBaseUrl()}/accept-invite/${token}`;

  const member = await TeamMember.create({
    clientID,
    email: normalizedEmail,
    firstName: firstName || '',
    lastName: lastName || '',
    passwordHash: unusablePasswordHash(),
    orgRole: ['admin', 'manager', 'member'].includes(orgRole) ? orgRole : 'member',
    permissions: memberPermissions,
    status: 'invited',
    invitedBy: invitedBy || null,
    inviteToken: token,
    inviteExpires: new Date(Date.now() + INVITE_TTL_MS),
  });

  try {
    await sendInviteEmail({ client, member, inviteUrl });
  } catch (err) {
    await TeamMember.deleteOne({ _id: member._id });
    console.error('[teamInvite] Send failed:', err.message);
    throw httpError(500, err.message || 'Failed to send invite email');
  }

  return {
    success: true,
    message: 'Invite email sent',
    member,
  };
}

async function resendTeamInvite({ clientID, memberId }) {
  const client = await Client.findOne({ clientID });
  if (!client) throw httpError(404, 'Client not found');

  const member = await TeamMember.findOne({ _id: memberId, clientID }).select('+inviteToken');
  if (!member) throw httpError(404, 'Team member not found');

  if (member.status !== 'invited') {
    throw httpError(400, 'Only invited members can receive a new invite email');
  }

  const token = crypto.randomBytes(32).toString('hex');
  member.inviteToken = token;
  member.inviteExpires = new Date(Date.now() + INVITE_TTL_MS);
  await member.save();

  const inviteUrl = `${getDashboardBaseUrl()}/accept-invite/${token}`;

  try {
    await sendInviteEmail({ client, member, inviteUrl });
  } catch (err) {
    console.error('[teamInvite] Resend failed:', err.message);
    throw httpError(500, err.message || 'Failed to send invite email');
  }

  return { success: true, message: 'Invite email resent' };
}

async function getTeamInvitePreview({ token }) {
  if (!token) throw httpError(400, 'Invite token is required');

  const member = await TeamMember.findOne({
    inviteToken: token,
    inviteExpires: { $gt: new Date() },
    status: 'invited',
  });

  if (!member) {
    throw httpError(400, 'Invalid or expired invite link');
  }

  const client = await Client.findOne({ clientID: member.clientID }).select('clientID companyName');
  if (!client) throw httpError(404, 'Organization not found');

  return {
    success: true,
    clientID: client.clientID,
    companyName: client.companyName || client.clientID,
    email: member.email,
    firstName: member.firstName || '',
    lastName: member.lastName || '',
  };
}

async function completeTeamInvite({ token, password }) {
  if (!token) throw httpError(400, 'Invite token is required');
  if (!password || String(password).length < 6) {
    throw httpError(400, 'Password must be at least 6 characters');
  }

  const member = await TeamMember.findOne({
    inviteToken: token,
    inviteExpires: { $gt: new Date() },
    status: 'invited',
  }).select('+passwordHash +inviteToken');

  if (!member) {
    throw httpError(400, 'Invalid or expired invite link');
  }

  member.passwordHash = bcrypt.hashSync(String(password), 10);
  member.status = 'active';
  member.inviteToken = null;
  member.inviteExpires = null;
  await member.save();

  console.log(`[teamInvite] Invite accepted for member ${member._id} (${member.clientID})`);

  return {
    success: true,
    message: 'Account activated. You can sign in with your Client ID, email, and password.',
    clientID: member.clientID,
    email: member.email,
  };
}

module.exports = {
  INVITE_TTL_MS,
  issueTeamInvite,
  resendTeamInvite,
  getTeamInvitePreview,
  completeTeamInvite,
};
