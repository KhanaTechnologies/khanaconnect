const nodemailer = require('nodemailer');

// Function to send user verification email
async function sendVerificationEmail(userEmail, verificationToken, bEmail, BEPass) {
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
        // Send the verification email
        await transporter.sendMail({
            from: bEmail, // Your GoDaddy email address
            to: userEmail,
            subject: 'Verify Your Account',
            html: `
                <p>Hello,</p>
                <p>Please verify your account by clicking the link below:</p>
                <a href="https://khanaconnect.onrender.com/api/v1/customer/verify-email?token=${verificationToken}">
                    Verify Your Account
                </a>
                <p>This link will expire in 1 hour.</p>
            `
        });

        console.log('Verification email sent successfully');
    } catch (error) {
        console.error('Error sending verification email:', error);
        throw error; // Throw error to handle it in the calling function
    }
}

module.exports = { sendVerificationEmail };
