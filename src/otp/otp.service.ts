import { Injectable, Logger } from '@nestjs/common';
import { sendMail } from 'src/common/mailer.util';
import { otpEmailHtml } from 'src/common/otp-email.util';

// Matches AuthService.OTP_TTL_SECONDS (5 minutes) — the real expiry of the code this sends.
const OTP_EXPIRY_MINUTES = 5;

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  async sendOtp(toEmail: string, otp: string): Promise<void> {
    const appName = process.env.APP_NAME || 'Edudeen';
    try {
      const id = await sendMail({
        to: toEmail,
        subject: `Your ${appName} verification code`,
        text: `Your ${appName} verification code is: ${otp}. It expires in ${OTP_EXPIRY_MINUTES} minutes. Never share this code with anyone.`,
        html: otpEmailHtml({
          appName,
          title: 'Verify Your Email',
          message: 'Use the code below to verify your email address.',
          otp,
          expiryMinutes: OTP_EXPIRY_MINUTES,
        }),
      });
      // No recipient address in the log line (PII); the message id is enough to trace a delivery.
      this.logger.log(`OTP email sent (id ${id ?? 'n/a'})`);
    } catch (error: any) {
      // The real cause (EAUTH = wrong credentials, ETIMEDOUT / ECONNREFUSED = host blocks SMTP,
      // Brevo 401 = bad API key) so the deploy logs say exactly what to fix — without the recipient.
      this.logger.error(
        `Failed to send OTP email: ${error?.code ?? ''} ${error?.message ?? error}`,
      );
      throw new Error('Failed to send OTP email');
    }
  }
}
