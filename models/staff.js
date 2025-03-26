const mongoose = require("mongoose");

const staffSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  role: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    unique: true, // Ensuring no duplicate emails
  },
  phone: {
    type: String,
    required: true,
    trim: true,
  },
  skills: {
    type: [String], // Array to store multiple skills
  },
  isActive: {
    type: Boolean,
    default: true, // To track if staff member is active
  },
  clientID: {
    type: String,
    required: true, // Ensures every staff member is linked to a client
  },
}, { timestamps: true });

module.exports = mongoose.model("Staff", staffSchema);
