const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');

// Create a nodemailer transporter
const transporter = nodemailer.createTransport({
  host: 'smtpout.secureserver.net', // GoDaddy SMTP server
  port: 465, // GoDaddy SMTP port (465 or 587)
  secure: true, // true for 465, false for other ports
  auth: {
    user: 'favour@gratiiam.co.za', // Your GoDaddy email address
    pass: 'FavourAuv1' // Your GoDaddy email password
  }
});

// Function to send a verification email
async function sendVerificationEmail(email, verificationToken) {
  try {
    // Send email
    await transporter.sendMail({
      from: 'favour@gratiiam.co.za', // Your GoDaddy email address
      to: email,
      subject: 'Verify your email address',
      html: `
        <p>Please click the following link to verify your email address:</p>
        <a href="http://localhost:3000/api/v1/customer/verify?token=${verificationToken}">Verify Email</a>
      `
    });

    console.log('Verification email sent successfully');
  } catch (error) {
    console.error('Error sending verification email:', error);
    throw error; // Throw error to handle it in the calling function
  }
}

module.exports = router;
