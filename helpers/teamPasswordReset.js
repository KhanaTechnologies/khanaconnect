const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Client = require('../models/client');
const TeamMember = require('../models/teamMember');
const { findTeamMemberByEmail, normalizeTeamEmail } = require('./teamMemberLookup');
const { ensureOwnerMember } = require('./teamLogin');
const { sendTeamDashboardResetEmail } = require('../utils/email');

function getDashboardBaseUrl() {
  return (process.env.DASHBOARD_URL || 'https://khanatechnologies.co.za').replace(/\/$/, '');
}

function isLegacyTeamResetEnabled() {
  return process.env.ALLOW_LEGACY_TEAM_PASSWORD_RESET === 'true';
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function getKhanaAdminClient() {
  let admin = await Client.findOne({ role: { $regex: /^admin$/i } }).select(
    'clientID companyName businessEmail businessEmailPassword emailSignature smtpHost smtpPort'
  );

  if (!admin) {
    admin = await Client.findOne({ clientID: { $regex: /^admin$/i } }).select(
      'clientID companyName businessEmail businessEmailPassword emailSignature smtpHost smtpPort'
    );
  }

  if (!admin?.businessEmail || !admin?.businessEmailPassword) {
    throw httpError(
      500,
      'Khana admin mailbox is not configured (businessEmail + businessEmailPassword on the admin client)'
    );
  }

  return admin;
}

async function clientHasOwner(clientID) {
  const owner = await TeamMember.findOne({ clientID, orgRole: 'owner' });
  return !!owner;
}

function emailMatchesClientBusiness(client, normalizedEmail) {
  if (!client?.businessEmail) return false;
  return client.businessEmail.toLowerCase() === normalizedEmail;
}

async function sendResetEmailToAddress({ client, email, resetUrl, memberName }) {
  const admin = await getKhanaAdminClient();
  const memberEmail = normalizeTeamEmail(email);

  console.log(
    `[teamPasswordReset] Sending reset email to ${memberEmail} for ${client.clientID} via admin mailbox`
  );

  await sendTeamDashboardResetEmail({
    memberEmail,
    memberName: memberName || memberEmail,
    companyName: client.companyName || client.clientID,
    clientID: client.clientID,
    resetLink: resetUrl,
    adminBusinessEmail: admin.businessEmail,
    adminBusinessEmailPassword: admin.businessEmailPassword,
    adminCompanyName: admin.companyName,
    emailSignature: admin.emailSignature || '',
    adminClientId: admin.clientID,
  });
}

async function issueLegacyTeamPasswordReset({ clientID, email, options = {} }) {
  if (!isLegacyTeamResetEnabled()) {
    throw httpError(403, 'Legacy owner password reset is disabled');
  }

  const normalizedEmail = normalizeTeamEmail(email);
  if (!normalizedEmail) {
    throw httpError(400, 'Valid email is required');
  }

  const client = await Client.findOne({ clientID });
  if (!client) throw httpError(404, 'Client not found');

  if (await clientHasOwner(clientID)) {
    throw httpError(409, 'This client already has an owner. Use normal team password reset.');
  }

  if (!options.bypassEmailCheck && !emailMatchesClientBusiness(client, normalizedEmail)) {
    throw httpError(
      400,
      'For legacy reset, use the business email on file or ask Khana admin to send the reset link'
    );
  }

  const token = crypto.randomBytes(32).toString('hex');
  client.teamLegacyResetToken = token;
  client.teamLegacyResetExpires = new Date(Date.now() + 60 * 60 * 1000);
  client.teamLegacyResetEmail = normalizedEmail;
  await client.save();

  const resetUrl = `${getDashboardBaseUrl()}/reset-password/${token}`;

  try {
    await sendResetEmailToAddress({
      client,
      email: normalizedEmail,
      resetUrl,
      memberName: client.companyName || 'Owner',
    });
  } catch (err) {
    console.error('[teamPasswordReset] Legacy send failed:', err.message);
    client.teamLegacyResetToken = null;
    client.teamLegacyResetExpires = null;
    client.teamLegacyResetEmail = null;
    await client.save();
    throw httpError(500, err.message || 'Failed to send password reset email');
  }

  console.log(
    `[teamPasswordReset] Legacy owner-setup reset sent for ${clientID} → ${normalizedEmail}`
  );

  return {
    success: true,
    message: 'Owner setup reset email sent',
    legacy: true,
  };
}

async function issueTeamPasswordReset({ clientID, memberId }) {
  const client = await Client.findOne({ clientID });
  if (!client) throw httpError(404, 'Client not found');

  const member = await TeamMember.findById(memberId);
  if (!member || member.clientID !== clientID) {
    throw httpError(404, 'Team member not found');
  }

  if (member.status === 'disabled') {
    throw httpError(403, 'This account has been disabled');
  }

  const token = crypto.randomBytes(32).toString('hex');
  member.resetPasswordToken = token;
  member.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000);
  await member.save();

  const resetUrl = `${getDashboardBaseUrl()}/reset-password/${token}`;

  try {
    await sendResetEmailToAddress({
      client,
      email: member.email,
      resetUrl,
      memberName: member.displayName || member.firstName || member.email,
    });
  } catch (err) {
    console.error('[teamPasswordReset] Send failed:', err.message);
    member.resetPasswordToken = null;
    member.resetPasswordExpires = null;
    await member.save();
    throw httpError(500, err.message || 'Failed to send password reset email');
  }

  return { success: true, message: 'Password reset email sent' };
}

async function requestTeamPasswordReset({ clientID, email }) {
  const normalizedEmail = normalizeTeamEmail(email);
  if (!clientID || !normalizedEmail) {
    throw httpError(400, 'Client ID and email are required');
  }

  const client = await Client.findOne({ clientID });
  if (!client) {
    console.warn(`[teamPasswordReset] Reset requested for unknown clientID=${clientID}`);
    return {
      success: true,
      message: 'If an account exists with that Client ID and email, a reset link has been sent.',
    };
  }

  const member = await findTeamMemberByEmail(clientID, normalizedEmail);
  if (member) {
    if (member.status === 'disabled') {
      console.warn(`[teamPasswordReset] Disabled member reset blocked: ${member._id}`);
      return {
        success: true,
        message: 'If an account exists with that Client ID and email, a reset link has been sent.',
      };
    }

    await issueTeamPasswordReset({ clientID, memberId: member._id });
    return {
      success: true,
      message: 'If an account exists with that Client ID and email, a reset link has been sent.',
    };
  }

  if (isLegacyTeamResetEnabled() && !(await clientHasOwner(clientID))) {
    if (emailMatchesClientBusiness(client, normalizedEmail)) {
      await issueLegacyTeamPasswordReset({ clientID, email: normalizedEmail });
      return {
        success: true,
        message: 'If an account exists with that Client ID and email, a reset link has been sent.',
      };
    }
    console.warn(
      `[teamPasswordReset] Legacy reset blocked — email ${normalizedEmail} does not match business email for ${clientID}`
    );
  } else {
    console.warn(
      `[teamPasswordReset] No team member for clientID=${clientID} email=${normalizedEmail} — no email sent`
    );
  }

  return {
    success: true,
    message: 'If an account exists with that Client ID and email, a reset link has been sent.',
  };
}

async function completeLegacyTeamPasswordReset({ client, password }) {
  const normalizedEmail = normalizeTeamEmail(client.teamLegacyResetEmail);
  const passwordHash = bcrypt.hashSync(String(password), 10);

  const member = await ensureOwnerMember(client, normalizedEmail, passwordHash);
  member.passwordHash = passwordHash;
  member.email = normalizedEmail;
  member.status = 'active';
  await member.save();

  client.password = passwordHash;
  client.teamLegacyResetToken = null;
  client.teamLegacyResetExpires = null;
  client.teamLegacyResetEmail = null;
  await client.save();

  console.log(
    `[teamPasswordReset] Legacy owner created for ${client.clientID} (${normalizedEmail})`
  );

  return { success: true, message: 'Password updated successfully. You can sign in as owner.' };
}

async function completeTeamPasswordReset({ token, password }) {
  if (!token) throw httpError(400, 'Reset token is required');
  if (!password || String(password).length < 6) {
    throw httpError(400, 'Password must be at least 6 characters');
  }

  const member = await TeamMember.findOne({
    resetPasswordToken: token,
    resetPasswordExpires: { $gt: new Date() },
  }).select('+passwordHash +resetPasswordToken +resetPasswordExpires');

  if (member) {
    const passwordHash = bcrypt.hashSync(String(password), 10);
    member.passwordHash = passwordHash;
    member.resetPasswordToken = null;
    member.resetPasswordExpires = null;
    await member.save();

    if (member.orgRole === 'owner') {
      await Client.updateOne({ clientID: member.clientID }, { $set: { password: passwordHash } });
    }

    console.log(`[teamPasswordReset] Password updated for member ${member._id} (${member.clientID})`);
    return { success: true, message: 'Password updated successfully' };
  }

  const client = await Client.findOne({
    teamLegacyResetToken: token,
    teamLegacyResetExpires: { $gt: new Date() },
  }).select('+teamLegacyResetToken +teamLegacyResetExpires +teamLegacyResetEmail +password');

  if (client) {
    return completeLegacyTeamPasswordReset({ client, password });
  }

  throw httpError(400, 'Invalid or expired reset link');
}

module.exports = {
  getDashboardBaseUrl,
  getKhanaAdminClient,
  isLegacyTeamResetEnabled,
  issueLegacyTeamPasswordReset,
  issueTeamPasswordReset,
  requestTeamPasswordReset,
  completeTeamPasswordReset,
};
