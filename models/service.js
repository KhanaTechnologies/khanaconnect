const mongoose = require('mongoose');

const serviceSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },
    description: {
        type: String,
        trim: true,
    },
    price: {
        type: Number,
        required: true,
    },
    clientID: {
        type: String,
        required: true,  // Ensures each service is linked to a client
    }
}, { timestamps: true });

module.exports = mongoose.model("Service", serviceSchema);
