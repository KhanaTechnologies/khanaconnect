const mongoose = require('mongoose');

const categorySchema = mongoose.Schema({
    name: { type: String, required: true },
    description: { type: String, default: '' },
    image: { type: String },
    icon: { type: String },
    color: { type: String },
    clientID: { type: String },
    /** Optional parent for 2-level trees (root → child). null = root. */
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      default: null,
      index: true,
    },
});

categorySchema.index({ clientID: 1, parentId: 1 });
categorySchema.virtual('id').get(function () { return this._id.toHexString(); });
categorySchema.set('toJSON', { virtuals: true });

exports.Category = mongoose.model('Category', categorySchema);
