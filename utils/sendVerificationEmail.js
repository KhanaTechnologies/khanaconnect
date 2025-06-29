const nodemailer = require('nodemailer');

// Function to send user verification email
async function sendVerificationEmail(userEmail, verificationURL, bEmail, BEPass, websiteURL, clientName) {
    console.log(userEmail, verificationURL, bEmail, BEPass, websiteURL, clientName);
    const formattedClientName = clientName
        ? 'The ' + clientName.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase()).trim() + ' Team'
        : 'The Khana Connect Team';

    const transporter = nodemailer.createTransport({
        host: 'smtpout.secureserver.net',
        port: 465,
        secure: true,
        auth: {
            user: bEmail,
            pass: BEPass
        }
    });

    const emailContent = `
    <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
        <h2 style="text-align: center; color: #444;">Verify Your Email Address</h2>
        <p>Hi there,</p>
        <p>Thank you for registering. Please verify your email address by clicking the button below:</p>

        <div style="text-align: center; margin: 30px 0;">
            <a href="${verificationURL}" style="background-color: #28a745; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px;">
                Verify My Account
            </a>
        </div>

        <p>If the button above doesn’t work, copy and paste this link into your browser:</p>
        <p style="word-break: break-all;"><a href="${verificationURL}">${verificationURL}</a></p>

        <p>This link will expire in 1 hour.</p>
        <p>If you didn’t sign up for an account, please ignore this email.</p>

        <p style="margin-top: 30px;">Warm regards,<br>${formattedClientName}</p>

        <hr style="margin-top: 40px;">
        <p style="font-size: 12px; color: #888;">This email was sent by ${formattedClientName.replace('The ', '').replace(' Team', '')} for account verification purposes.</p>
    </div>
    `;

    try {
        await transporter.sendMail({
            from: bEmail,
            to: userEmail,
            subject: 'Verify Your Email Address',
            html: emailContent
        });

        console.log('Verification email sent successfully');
    } catch (error) {
        console.error('Error sending verification email:', error);
        throw error;
    }
}

module.exports = { sendVerificationEmail };
