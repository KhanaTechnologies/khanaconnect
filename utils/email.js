const nodemailer = require('nodemailer');

// Function to send a verification email
async function sendVerificationEmail(email, verificationToken, bEmail, BEPass) {
    // Create a nodemailer transporter
    const transporter = nodemailer.createTransport({
    host: 'smtpout.secureserver.net', // GoDaddy SMTP server
    port: 465, // GoDaddy SMTP port (465 or 587)
    secure: true, // true for 465, false for other ports
    auth: {
        user: bEmail, // Your GoDaddy email address
        pass: BEPass // Your GoDaddy email password
    }
    });


  try {
    // Send email
    await transporter.sendMail({
      from: bEmail, // Your GoDaddy email address
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


async function orderItemProcessed(email, bEmail, BEPass){
   // Create a nodemailer transporter
   const transporter = nodemailer.createTransport({
    host: 'smtpout.secureserver.net', // GoDaddy SMTP server
    port: 465, // GoDaddy SMTP port (465 or 587)
    secure: true, // true for 465, false for other ports
    auth: {
        user: bEmail, // Your GoDaddy email address
        pass: BEPass // Your GoDaddy email password
    }
    });


  try {
    // Send email
    await transporter.sendMail({
      from: bEmail, // Your GoDaddy email address
      to: email,
      subject: 'Order Processed',
      html: `
        <p>Please note that your order has been processed!</p>
      `
    });

    console.log('Email Update sent successfully');
  } catch (error) {
    console.error('Error sending email  update:', error);
    throw error; // Throw error to handle it in the calling function
  }
}

module.exports = { sendVerificationEmail,orderItemProcessed};
