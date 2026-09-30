import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class OtpService {
  private transporter: nodemailer.Transporter;
  private readonly logger = new Logger(OtpService.name);

  constructor(private configService: ConfigService) {
    this.transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASSWORD'),
      },
    });
  }

  async sendOtp(toEmail: string, otp: string): Promise<void> {
    try {
      const mailOptions = {
        // Was a hard-coded personal Gmail address: mail from any other SMTP_USER was rejected/spoofed. Uses the configured sender.
        from: this.configService.get<string>('SMTP_FROM') || this.configService.get<string>('SMTP_USER'),
        to: toEmail,
        subject: 'Your OTP Code',
        text: `Your OTP code is: ${otp}`,
        html: `<p>Your OTP code is: <b>${otp}</b></p>`,
      };

      const result = await this.transporter.sendMail(mailOptions);

      // No recipient address or SMTP response in the log line (PII); the message id is enough to trace a delivery.
      this.logger.log(`OTP email sent (id ${result.messageId ?? 'n/a'})`);
    } catch (error) {
      this.logger.error(`Failed to send OTP email: ${(error as Error)?.message}`);
      throw new Error('Failed to send OTP email');
    }
  }
}
