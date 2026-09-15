/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from '../otp/services/email.service';

const APP_NAME = process.env.APP_NAME || 'Edudeen';

// Identical shell to SubscriptionNotificationsService's — kept as its own
// copy (not a shared import) so the two billing systems' notification
// services stay fully independent modules, matching the rest of this
// feature's "separate but parallel" design (see EntitlementsService docs).
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
      <p>This is an automated email regarding your Edudeen platform plan. Please do not reply.</p>
    </div>
  </div>
</body>
</html>`;
}

const money = (n: number) => `$${Math.abs(n).toFixed(2)}`;

/** Seller-facing emails for platform-plan (seller-to-Edudeen) billing — same visual style/shell as SubscriptionNotificationsService, different audience (sellers, not buyers). */
@Injectable()
export class PlatformPlanNotificationsService {
  private readonly logger = new Logger(PlatformPlanNotificationsService.name);

  constructor(private readonly emailService: EmailService) {}

  private async send(to: string, subject: string, html: string) {
    try {
      const ok = await this.emailService.sendMail(to, subject, html);
      if (!ok) this.logger.warn(`Platform-plan email not sent (provider returned false): ${subject} -> ${to}`);
    } catch (err: any) {
      // Never let a notification failure break the billing flow that triggered it.
      this.logger.error(`Failed to send platform-plan email "${subject}" to ${to}: ${err?.message}`);
    }
  }

  async sendPlanUpgraded(to: string, data: {
    sellerName: string; storeName: string; fromPlanName: string; toPlanName: string; amountUSD: number;
  }) {
    const html = shell('Your platform plan was changed', `
      <p>Hi ${data.sellerName},</p>
      <p>Your store <strong>${data.storeName}</strong>'s Edudeen platform plan has been updated.</p>
      <div class="box">
        <div class="row"><span class="label">Previous plan</span><span class="value">${data.fromPlanName}</span></div>
        <div class="row"><span class="label">New plan</span><span class="value">${data.toPlanName}</span></div>
      </div>
      <div class="amount">${money(data.amountUSD)} charged</div>
      <p style="text-align:center;color:#666;font-size:13px;">This is a prorated charge for the remainder of your current billing period.</p>
    `);
    await this.send(to, `Your platform plan was changed — ${money(data.amountUSD)} charged`, html);
  }

  async sendPlanChangeCredited(to: string, data: {
    sellerName: string; storeName: string; fromPlanName: string; toPlanName: string; creditUSD: number;
  }) {
    const html = shell('Your platform plan was changed', `
      <p>Hi ${data.sellerName},</p>
      <p>Your store <strong>${data.storeName}</strong>'s Edudeen platform plan has been updated.</p>
      <div class="box">
        <div class="row"><span class="label">Previous plan</span><span class="value">${data.fromPlanName}</span></div>
        <div class="row"><span class="label">New plan</span><span class="value">${data.toPlanName}</span></div>
      </div>
      <div class="success">
        <strong>No charge today.</strong> ${money(data.creditUSD)} in unused time has been credited to your
        account and will automatically reduce your next bill.
      </div>
    `);
    await this.send(to, `Your platform plan was changed — ${money(data.creditUSD)} credited to your account`, html);
  }

  async sendMovedToFreePlan(to: string, data: { sellerName: string; storeName: string; planName: string }) {
    const html = shell('Your plan is now free', `
      <p>Hi ${data.sellerName},</p>
      <p>Your store <strong>${data.storeName}</strong> is now on the free "${data.planName}" plan.</p>
      <div class="box">You can upgrade again any time from your seller dashboard — no long-term commitment either way.</div>
    `);
    await this.send(to, `${data.storeName} moved to the free plan`, html);
  }

  async sendPaymentFailed(to: string, data: {
    sellerName: string; storeName: string; planName: string; amountUSD: number;
    attemptNumber: number; maxAttempts: number; nextRetryDate: Date;
  }) {
    const html = shell('Platform plan payment failed', `
      <p>Hi ${data.sellerName},</p>
      <p>We couldn't process your platform-plan payment for <strong>${data.storeName}</strong> — ${data.planName}.</p>
      <div class="danger">
        <strong>Attempt ${data.attemptNumber} of ${data.maxAttempts} failed</strong> for ${money(data.amountUSD)}.
      </div>
      <p>We'll automatically retry on <strong>${data.nextRetryDate.toDateString()}</strong>. To avoid your store being
      moved to the free plan, please make sure your payment method is up to date before then.</p>
    `);
    await this.send(to, `Action needed: payment failed for ${data.storeName}`, html);
  }

  async sendDowngradedDueToFailedPayments(to: string, data: { sellerName: string; storeName: string; planName: string; maxAttempts: number }) {
    const html = shell('Your store was downgraded', `
      <p>Hi ${data.sellerName},</p>
      <p>Your store <strong>${data.storeName}</strong> has been moved to the free "${data.planName}" plan after
      ${data.maxAttempts} failed payment attempts.</p>
      <div class="warning">Any features exclusive to your previous tier (staff seats, custom domain, loyalty program,
      etc.) are now paused until you upgrade again — your store and existing data are safe and unaffected.</div>
    `);
    await this.send(to, `${data.storeName} was moved to the free plan after failed payments`, html);
  }

  async sendTrialEndingSoon(to: string, data: { sellerName: string; storeName: string; planName: string; amountUSD: number; daysLeft: number; trialEndsAt: Date }) {
    const html = shell('Your trial is ending soon', `
      <p>Hi ${data.sellerName},</p>
      <p>Your <strong>${data.planName}</strong> trial for <strong>${data.storeName}</strong> ends in
      <strong>${data.daysLeft} day${data.daysLeft === 1 ? '' : 's'}</strong> (${data.trialEndsAt.toDateString()}).</p>
      <div class="box">
        <div class="row"><span class="label">Plan after trial</span><span class="value">${data.planName}</span></div>
        <div class="row"><span class="label">Amount to be charged</span><span class="value">${money(data.amountUSD)}</span></div>
      </div>
      <p style="text-align:center;color:#666;font-size:13px;">No action needed if you want to continue — your card will be charged automatically when the trial ends.</p>
    `);
    await this.send(to, `Your ${data.storeName} trial ends in ${data.daysLeft} day${data.daysLeft === 1 ? '' : 's'}`, html);
  }
}
