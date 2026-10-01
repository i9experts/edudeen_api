import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private transporter: nodemailer.Transporter;

  constructor() {
    // Configure email transporter
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT as string) || 587,
      secure: false, // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    });
  }

  async sendOtpEmail(
    email: string,
    otp: string,
    type: string = 'email_verification',
  ): Promise<boolean> {
    const subject = this.getEmailSubject(type);
    const html = this.getEmailTemplate(otp, type);
    return this.sendMail(email, subject, html);
  }

  /** Generic transactional email — used by any module (e.g. subscription notifications). */
  async sendMail(to: string, subject: string, html: string): Promise<boolean> {
    try {
      const info = await this.transporter.sendMail({
        from: `"${process.env.APP_NAME || 'Your App'}" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
        to,
        subject,
        html,
      });

      console.log('✅ Email sent:', info.messageId);
      return true;
    } catch (error) {
      // Message only: the raw error carries the recipient address and the SMTP server's response.
      console.error('❌ Error sending email:', (error as Error)?.message);
      return false;
    }
  }

  private getEmailSubject(type: string): string {
    switch (type) {
      case 'email_verification':
        return 'Verify Your Email Address';
      case 'password_reset':
        return 'Reset Your Password';
      case 'login':
        return 'Your Login OTP';
      default:
        return 'Your Verification Code';
    }
  }

  private getEmailTemplate(otp: string, type: string): string {
    const appName = process.env.APP_NAME || 'Your App';
    const expiryMinutes =
      parseInt(process.env.OTP_EXPIRY_MINUTES as string) || 10;

    let title = 'Verify Your Email';
    let message = 'Please use the following code to verify your email address:';

    switch (type) {
      case 'password_reset':
        title = 'Reset Your Password';
        message = 'Please use the following code to reset your password:';
        break;
      case 'login':
        title = 'Login Verification';
        message = 'Please use the following code to complete your login:';
        break;
    }

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .container {
            background: #ffffff;
            border-radius: 10px;
            padding: 40px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
        }
        .header h1 {
            color: #2c3e50;
            margin: 0;
            font-size: 28px;
        }
        .otp-box {
            background: #f8f9fa;
            border: 2px dashed #3498db;
            border-radius: 8px;
            padding: 30px;
            text-align: center;
            margin: 30px 0;
        }
        .otp-code {
            font-size: 36px;
            font-weight: bold;
            color: #3498db;
            letter-spacing: 8px;
            margin: 10px 0;
        }
        .message {
            font-size: 16px;
            color: #555;
            margin: 20px 0;
            text-align: center;
        }
        .warning {
            background: #fff3cd;
            border-left: 4px solid #ffc107;
            padding: 15px;
            margin: 20px 0;
            border-radius: 4px;
        }
        .footer {
            text-align: center;
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            color: #888;
            font-size: 14px;
        }
        .button {
            display: inline-block;
            padding: 12px 30px;
            background: #3498db;
            color: white;
            text-decoration: none;
            border-radius: 5px;
            margin: 20px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔐 ${title}</h1>
        </div>
        
        <p class="message">${message}</p>
        
        <div class="otp-box">
            <div style="font-size: 14px; color: #666; margin-bottom: 10px;">
                Your verification code is:
            </div>
            <div class="otp-code">${otp}</div>
            <div style="font-size: 14px; color: #666; margin-top: 10px;">
                Valid for ${expiryMinutes} minutes
            </div>
        </div>
        
        <div class="warning">
            <strong>⚠️ Security Notice:</strong>
            <ul style="margin: 10px 0; padding-left: 20px;">
                <li>Never share this code with anyone</li>
                <li>Our team will never ask for your OTP</li>
                <li>This code expires in ${expiryMinutes} minutes</li>
            </ul>
        </div>
        
        <p style="text-align: center; color: #666; font-size: 14px;">
            If you didn't request this code, please ignore this email or contact support if you're concerned.
        </p>
        
        <div class="footer">
            <p>© ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
            <p>This is an automated email. Please do not reply.</p>
        </div>
    </div>
</body>
</html>
        `;
  }

  // Test email connection
  async testConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      console.log('✅ Email server connection verified');
      return true;
    } catch (error) {
      console.error('❌ Email server connection failed:', (error as Error)?.message);
      return false;
    }
  }
}
