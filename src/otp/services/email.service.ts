import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { sendMail as sendMailUtil } from 'src/common/mailer.util';
import { otpEmailHtml } from 'src/common/otp-email.util';

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
      // Shared outbound path (Brevo HTTPS API when BREVO_API_KEY is set,
      // SMTP otherwise) — see common/mailer.util.ts.
      const id = await sendMailUtil({ to, subject, html });
      console.log('✅ Email sent:', id);
      return true;
    } catch (error) {
      // Code + message only: the raw error carries the recipient address and the SMTP server's response.
      console.error(
        'Error sending email:',
        error?.code ?? '',
        (error as Error)?.message,
      );
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
    const appName = process.env.APP_NAME || 'Edudeen';
    const expiryMinutes =
      parseInt(process.env.OTP_EXPIRY_MINUTES as string) || 10;

    let title = 'Verify Your Email';
    let message = 'Use the code below to verify your email address.';

    switch (type) {
      case 'password_reset':
        title = 'Reset Your Password';
        message = 'Use the code below to reset your password.';
        break;
      case 'login':
        title = 'Login Verification';
        message = 'Use the code below to complete your login.';
        break;
    }

    return otpEmailHtml({ appName, title, message, otp, expiryMinutes });
  }

  // Test email connection
  async testConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      console.log('✅ Email server connection verified');
      return true;
    } catch (error) {
      console.error(
        '❌ Email server connection failed:',
        (error as Error)?.message,
      );
      return false;
    }
  }
}
