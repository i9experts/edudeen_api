/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from '../otp/services/email.service';

const APP_NAME = process.env.APP_NAME || 'Edudeen';

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
  .amount { font-size: 28px; font-weight: bold; text-align: center; margin: 10px 0; }
  .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 4px; }
  .success { background: #e8f8ee; border-left: 4px solid #22c55e; padding: 15px; margin: 20px 0; border-radius: 4px; }
  .danger { background: #fdecea; border-left: 4px solid #e53935; padding: 15px; margin: 20px 0; border-radius: 4px; }
  .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; color: #888; font-size: 13px; }
</style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>${title}</h1></div>
    ${bodyHtml}
    <div class="footer">
      <p>© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
      <p>This is an automated email regarding your subscription. Please do not reply.</p>
    </div>
  </div>
</body>
</html>`;
}

const money = (n: number) => `$${Math.abs(n).toFixed(2)}`;

@Injectable()
export class SubscriptionNotificationsService {
  private readonly logger = new Logger(SubscriptionNotificationsService.name);

  constructor(private readonly emailService: EmailService) {}

  private async send(to: string, subject: string, html: string) {
    try {
      const ok = await this.emailService.sendMail(to, subject, html);
      if (!ok) this.logger.warn(`Subscription email not sent (provider returned false): ${subject} -> ${to}`);
    } catch (err) {
      // Never let a notification failure break the billing/proration flow that triggered it.
      this.logger.error(`Failed to send subscription email "${subject}" to ${to}: ${err?.message}`);
    }
  }

  async sendProrationCharged(to: string, data: {
    customerName: string; storeName: string; fromPlanName: string; toPlanName: string;
    fromInterval: string; toInterval: string; amountUSD: number;
  }) {
    const html = shell('Your plan was changed', `
      <p>Hi ${data.customerName},</p>
      <p>Your subscription with <strong>${data.storeName}</strong> has been updated.</p>
      <div class="box">
        <div class="row"><span class="label">Previous plan</span><span class="value">${data.fromPlanName} (${data.fromInterval})</span></div>
        <div class="row"><span class="label">New plan</span><span class="value">${data.toPlanName} (${data.toInterval})</span></div>
      </div>
      <div class="amount">${money(data.amountUSD)} charged</div>
      <p style="text-align:center;color:#666;font-size:13px;">This is a prorated charge for the remainder of your current billing period.</p>
    `);
    await this.send(to, `Your plan was changed — ${money(data.amountUSD)} charged`, html);
  }

  async sendProrationCredited(to: string, data: {
    customerName: string; storeName: string; fromPlanName: string; toPlanName: string;
    fromInterval: string; toInterval: string; creditUSD: number;
  }) {
    const html = shell('Your plan was changed', `
      <p>Hi ${data.customerName},</p>
      <p>Your subscription with <strong>${data.storeName}</strong> has been updated.</p>
      <div class="box">
        <div class="row"><span class="label">Previous plan</span><span class="value">${data.fromPlanName} (${data.fromInterval})</span></div>
        <div class="row"><span class="label">New plan</span><span class="value">${data.toPlanName} (${data.toInterval})</span></div>
      </div>
      <div class="success">
        <strong>No charge today.</strong> ${money(data.creditUSD)} in unused time has been credited to your
        account and will automatically reduce your next bill.
      </div>
    `);
    await this.send(to, `Your plan was changed — ${money(data.creditUSD)} credited to your account`, html);
  }

  async sendPaymentFailed(to: string, data: {
    customerName: string; storeName: string; planName: string; amountUSD: number;
    attemptNumber: number; maxAttempts: number; nextRetryDate: Date;
  }) {
    const html = shell('Payment failed', `
      <p>Hi ${data.customerName},</p>
      <p>We couldn't process your renewal payment for <strong>${data.storeName}</strong> — ${data.planName}.</p>
      <div class="danger">
        <strong>Attempt ${data.attemptNumber} of ${data.maxAttempts} failed</strong> for ${money(data.amountUSD)}.
      </div>
      <p>We'll automatically retry on <strong>${data.nextRetryDate.toDateString()}</strong>. To avoid interruption,
      please make sure your payment method is up to date before then.</p>
    `);
    await this.send(to, `Action needed: payment failed for ${data.storeName}`, html);
  }

  async sendRenewalReminder(to: string, data: {
    customerName: string; storeName: string; planName: string; amountUSD: number; renewalDate: Date; daysUntilRenewal: number;
  }) {
    const html = shell('Your subscription renews soon', `
      <p>Hi ${data.customerName},</p>
      <p>Your subscription to <strong>${data.storeName}</strong> — ${data.planName} will renew in
      <strong>${data.daysUntilRenewal} day${data.daysUntilRenewal === 1 ? '' : 's'}</strong> (${data.renewalDate.toDateString()}).</p>
      <div class="box">
        <div class="row"><span class="label">Renewal amount</span><span class="value">${money(data.amountUSD)}</span></div>
        <div class="row"><span class="label">Renewal date</span><span class="value">${data.renewalDate.toDateString()}</span></div>
      </div>
      <p style="text-align:center;color:#666;font-size:13px;">No action needed if your payment method is up to date.</p>
    `);
    await this.send(to, `Your ${data.storeName} subscription renews in ${data.daysUntilRenewal} day${data.daysUntilRenewal === 1 ? '' : 's'}`, html);
  }

  async sendSubscriptionCanceledDueToFailedPayments(to: string, data: {
    customerName: string; storeName: string; planName: string; maxAttempts: number;
  }) {
    const html = shell('Subscription canceled', `
      <p>Hi ${data.customerName},</p>
      <p>Your subscription to <strong>${data.storeName}</strong> — ${data.planName} has been canceled after
      ${data.maxAttempts} failed payment attempts.</p>
      <div class="warning">You can resubscribe at any time from the store's page once your payment method is updated.</div>
    `);
    await this.send(to, `Your subscription to ${data.storeName} was canceled`, html);
  }
}
