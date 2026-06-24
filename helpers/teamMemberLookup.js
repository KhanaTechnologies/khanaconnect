const TeamMember = require('../models/teamMember');

function normalizeTeamEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

async function findTeamMemberByEmail(clientID, email, options = {}) {
  const normalizedEmail = normalizeTeamEmail(email);
  if (!normalizedEmail) return null;

  let query = TeamMember.find({ clientID });
  if (options.selectPasswordHash) {
    query = query.select('+passwordHash');
  }

  const members = await query;
  for (const member of members) {
    if (member.email.toLowerCase() === normalizedEmail) {
      return member;
    }
  }
  return null;
}

async function teamMemberEmailExists(clientID, email, excludeMemberId = null) {
  const member = await findTeamMemberByEmail(clientID, email);
  if (!member) return false;
  if (excludeMemberId && String(member._id) === String(excludeMemberId)) {
    return false;
  }
  return true;
}

module.exports = {
  normalizeTeamEmail,
  findTeamMemberByEmail,
  teamMemberEmailExists,
};
