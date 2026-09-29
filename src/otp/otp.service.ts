import { Injectable, Logger } from '@nestjs/common';
import { sendMail } from 'src/common/mailer.util';

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  async sendOtp(toEmail: string, otp: string): Promise<void> {
    const appName = process.env.APP_NAME || 'Edudeen';
    try {
      const id = await sendMail({
        to: toEmail,
        subject: `Your ${appName} verification code`,
        text: `Your ${appName} verification code is: ${otp}`,
        html: `<p>Your ${appName} verification code is: <b>${otp}</b></p><p>It expires in 5 minutes. Never share this code with anyone.</p>`,
      });
      this.logger.log(`OTP email sent to ${toEmail}: ${id}`);
    } catch (error: any) {
      // Logged with the real cause (EAUTH = wrong credentials, ETIMEDOUT /
      // ECONNREFUSED = host blocks SMTP, Brevo 401 = bad API key) so the
      // deploy logs say exactly what to fix.
      this.logger.error(`Failed to send OTP to ${toEmail}: ${error?.code ?? ''} ${error?.message ?? error}`);
      throw new Error('Failed to send OTP email');
    }
  }
}
