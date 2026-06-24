const Email = require('../models/Email');

/**
 * Production may still have a legacy uid+clientID unique index without a partial
 * filter, which rejects multiple outbound emails with uid: null.
 */
async function ensureEmailIndexes() {
  const coll = Email.collection;
  let indexes;

  try {
    indexes = await coll.indexes();
  } catch (err) {
    console.error('Could not read email indexes:', err.message);
    return;
  }

  const legacyUidIndex = indexes.find(
    (idx) => idx.name === 'uid_1_clientID_1' && !idx.partialFilterExpression
  );

  if (legacyUidIndex) {
    try {
      await coll.dropIndex('uid_1_clientID_1');
      console.log('Dropped legacy emails uid_1_clientID_1 index (missing partial filter)');
    } catch (err) {
      console.error('Could not drop legacy emails uid_1_clientID_1 index:', err.message);
    }
  }

  try {
    await Email.syncIndexes();
    console.log('Email indexes synced');
  } catch (err) {
    console.error('Email syncIndexes failed:', err.message);
  }
}

module.exports = { ensureEmailIndexes };
