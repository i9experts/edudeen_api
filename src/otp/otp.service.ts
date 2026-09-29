import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class OtpService {
  private transporter: nodemailer.Transporter;
  private readonly logger = new Logger(OtpService.name);

  constructor(private configService: ConfigService) {
    // Same SMTP settings as EmailService (SMTP_HOST/PORT/USER/PASSWORD), so
    // OTP and every other transactional email go out through one account
    // configured in one place.
    const port = parseInt(this.configService.get<string>('SMTP_PORT') ?? '', 10) || 587;
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('SMTP_HOST') || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASSWORD'),
      },
    });
  }

  async sendOtp(toEmail: string, otp: string): Promise<void> {
    const appName = this.configService.get<string>('APP_NAME') || 'Edudeen';
    const fromAddress =
      this.configService.get<string>('SMTP_FROM') || this.configService.get<string>('SMTP_USER');
    try {
      const mailOptions = {
        from: `"${appName}" <${fromAddress}>`,
        to: toEmail,
        subject: `Your ${appName} verification code`,
        text: `Your ${appName} verification code is: ${otp}`,
        html: `<p>Your ${appName} verification code is: <b>${otp}</b></p><p>It expires in 5 minutes. Never share this code with anyone.</p>`,
      };

      const result = await this.transporter.sendMail(mailOptions);

      this.logger.log(`OTP email sent to ${toEmail}: ${result.response}`);
    } catch (error) {
      this.logger.error(`Failed to send OTP to ${toEmail}`, error);
      throw new Error('Failed to send OTP email');
    }
  }
}
