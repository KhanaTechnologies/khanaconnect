const bcrypt = require('bcryptjs');
const TeamMember = require('../models/teamMember');
const Client = require('../models/client');
const { normalizeTeamEmail, teamMemberEmailExists } = require('./teamMemberLookup');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function changeTeamMemberLoginEmail({ clientID, memberId, newEmail }) {
  const normalizedEmail = normalizeTeamEmail(newEmail);
  if (!normalizedEmail) {
    throw httpError(400, 'Valid email is required');
  }

  const member = await TeamMember.findOne({ _id: memberId, clientID });
  if (!member) {
    throw httpError(404, 'Team member not found');
  }

  if (member.email.toLowerCase() === normalizedEmail) {
    return member;
  }

  const exists = await teamMemberEmailExists(clientID, normalizedEmail, memberId);
  if (exists) {
    throw httpError(409, 'A team member with this email already exists');
  }

  member.email = normalizedEmail;
  await member.save();
  return member;
}

async function changeTeamMemberPassword({ clientID, memberId, currentPassword, newPassword }) {
  if (!newPassword || String(newPassword).length < 6) {
    throw httpError(400, 'New password must be at least 6 characters');
  }

  const member = await TeamMember.findOne({ _id: memberId, clientID }).select('+passwordHash');
  if (!member) {
    throw httpError(404, 'Team member not found');
  }

  if (!currentPassword || !bcrypt.compareSync(String(currentPassword), member.passwordHash)) {
    throw httpError(400, 'Current password is incorrect');
  }

  const passwordHash = bcrypt.hashSync(String(newPassword), 10);
  member.passwordHash = passwordHash;
  await member.save();

  if (member.orgRole === 'owner') {
    await Client.updateOne({ clientID }, { $set: { password: passwordHash } });
  }

  return member;
}

module.exports = {
  changeTeamMemberLoginEmail,
  changeTeamMemberPassword,
};
