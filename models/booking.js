const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
    customerName: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    phoneNumber: {
      type: String,
      required: true,
      trim: true,
    },
    services: {
      type: [String], // Array to store multiple services
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    time: {
      type: String,
      required: true,
    },
    duration: {
      type: Number, // Optional field for duration in minutes
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff", // Now correctly references the Staff schema
      default: null, // Can be null until assigned
    },
    notes: {
      type: String,
      trim: true,
    },
    clientID: {
        type: String,
        required: true, // Ensures every staff member is linked to a client
      },
  }, { timestamps: true });
  
  module.exports = mongoose.model("Booking", bookingSchema);
  