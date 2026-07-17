async function findB2BBuyerByEmail(B2BBuyer, clientID, normalizedEmail) {
  const buyers = await B2BBuyer.find({ clientID }).select('+passwordHash');
  const target = normalizedEmail.trim().toLowerCase();
  for (const buyer of buyers) {
    if (String(buyer.email).toLowerCase() === target) {
      return buyer;
    }
  }
  return null;
}

module.exports = { findB2BBuyerByEmail };
