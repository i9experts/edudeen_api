/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from '../otp/services/email.service';

const APP_NAME = process.env.APP_NAME || 'Edudeen';

// Same email chrome as SubscriptionNotificationsService — copied rather than
// shared since that helper is a private module-level function, not exported.
function shell(title: string, bodyHtml: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title>
<style>
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
  .container { background: #ffffff; border-radius: 10px; padding: 40px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
  .header { text-align: center; margin-bottom: 24px; }
  .header h1 { color: #2c3e50; margin: 0; font-size: 24px; }
  .box { background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 20px 0; }
  .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; }
  .label { color: #666; }
  .value { font-weight: 600; color: #222; }
  .danger { background: #fdecea; border-left: 4px solid #e53935; padding: 15px; margin: 20px 0; border-radius: 4px; }
  .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 4px; }
  .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; color: #888; font-size: 13px; }
</style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>${title}</h1></div>
    ${bodyHtml}
    <div class="footer">
      <p>© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
      <p>This is an automated email regarding your seller platform plan. Please do not reply.</p>
    </div>
  </div>
</body>
</html>`;
}

const money = (n: number) => `$${Math.abs(n).toFixed(2)}`;

@Injectable()
export class PlatformBillingNotificationsService {
  private readonly logger = new Logger(PlatformBillingNotificationsService.name);

  constructor(private readonly emailService: EmailService) {}

  private async send(to: string, subject: string, html: string) {
    try {
      const ok = await this.emailService.sendMail(to, subject, html);
      if (!ok) this.logger.warn(`Platform billing email not sent (provider returned false): ${subject} -> ${to}`);
    } catch (err) {
      // Never let a notification failure break the billing flow that triggered it.
      this.logger.error(`Failed to send platform billing email "${subject}" to ${to}: ${err?.message}`);
    }
  }

  async sendPaymentFailed(to: string, data: {
    sellerName: string; storeName: string; tierName: string; amountUSD: number;
    attemptNumber: number; maxAttempts: number; nextRetryDate: Date;
  }) {
    const html = shell('Payment failed', `
      <p>Hi ${data.sellerName},</p>
      <p>We couldn't process your platform plan payment for <strong>${data.storeName}</strong> — ${data.tierName}.</p>
      <div class="danger">
        <strong>Attempt ${data.attemptNumber} of ${data.maxAttempts} failed</strong> for ${money(data.amountUSD)}.
      </div>
      <p>We'll automatically retry on <strong>${data.nextRetryDate.toDateString()}</strong>. To avoid your store
      dropping back to the free Starter plan, please make sure your payment method is up to date before then.</p>
    `);
    await this.send(to, `Action needed: payment failed for ${data.storeName}`, html);
  }

  async sendCanceledDueToFailedPayments(to: string, data: {
    sellerName: string; storeName: string; tierName: string; maxAttempts: number;
  }) {
    const html = shell('Plan downgraded', `
      <p>Hi ${data.sellerName},</p>
      <p>Your <strong>${data.storeName}</strong> plan (${data.tierName}) has been downgraded to the free Starter
      plan after ${data.maxAttempts} failed payment attempts.</p>
      <div class="warning">You can upgrade again at any time from your seller settings once your payment method is updated.</div>
    `);
    await this.send(to, `Your ${data.storeName} plan was downgraded`, html);
  }
}
