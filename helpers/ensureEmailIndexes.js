const Email = require('../models/Email');

const DESIRED_UID_INDEX = {
  unique: true,
  partialFilterExpression: { uid: { $type: 'number' } },
};

function indexSpecMatches(idx) {
  if (!idx || idx.name !== 'uid_1_clientID_1') return false;
  const hasPartial =
    idx.partialFilterExpression &&
    idx.partialFilterExpression.uid &&
    idx.partialFilterExpression.uid.$type === 'number';
  return idx.unique === true && hasPartial && idx.sparse !== true;
}

/**
 * Production may have a legacy uid+clientID index (no partial filter, or sparse+partial mix).
 * MongoDB rejects indexes that combine sparse with partialFilterExpression.
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

  const uidClientIndex = indexes.find((idx) => idx.name === 'uid_1_clientID_1');
  const needsDrop = uidClientIndex && !indexSpecMatches(uidClientIndex);

  if (needsDrop) {
    try {
      await coll.dropIndex('uid_1_clientID_1');
      console.log('Dropped emails uid_1_clientID_1 index for recreation (legacy or invalid spec)');
    } catch (err) {
      console.error('Could not drop emails uid_1_clientID_1 index:', err.message);
    }
  }

  try {
    await Email.syncIndexes();
    console.log('Email indexes synced');
  } catch (err) {
    console.error('Email syncIndexes failed:', err.message);
  }
}

module.exports = { ensureEmailIndexes, DESIRED_UID_INDEX };
