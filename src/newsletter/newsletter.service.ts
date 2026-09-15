import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as crypto from 'crypto';
import {
  NewsletterSubscriber,
  NewsletterSubscriberDocument,
} from './schemas/newsletter-subscriber.schema';
import { EmailService } from '../otp/services/email.service';

const APP_NAME = process.env.APP_NAME || 'Edudeen';

function confirmationEmailHtml(unsubscribeUrl: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Subscribed to ${APP_NAME} deals</title>
<style>
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
  .container { background: #ffffff; border-radius: 10px; padding: 40px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
  .header { text-align: center; margin-bottom: 24px; }
  .header h1 { color: #2c3e50; margin: 0; font-size: 24px; }
  .success { background: #e8f8ee; border-left: 4px solid #22c55e; padding: 15px; margin: 20px 0; border-radius: 4px; }
  .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; color: #888; font-size: 13px; }
  .footer a { color: #888; }
</style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>🎉 You're on the list!</h1></div>
    <div class="success">You'll now get deals, new arrivals and price-drop alerts from ${APP_NAME} straight to your inbox.</div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
      <p>Didn't request this? <a href="${unsubscribeUrl}">Unsubscribe</a> at any time.</p>
    </div>
  </div>
</body>
</html>`;
}

function unsubscribePageHtml(message: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${APP_NAME} newsletter</title>
<style>
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f8f9fa; color: #333; }
  .card { background: #fff; border-radius: 10px; padding: 40px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); text-align: center; max-width: 420px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
</style>
</head>
<body><div class="card"><h1>${APP_NAME}</h1><p>${message}</p></div></body>
</html>`;
}

@Injectable()
export class NewsletterService {
  constructor(
    @InjectModel(NewsletterSubscriber.name)
    private readonly subscriberModel: Model<NewsletterSubscriberDocument>,
    private readonly emailService: EmailService,
  ) {}

  async subscribe(email: string, source = 'footer') {
    const normalizedEmail = email.trim().toLowerCase();
    let subscriber = await this.subscriberModel.findOne({
      email: normalizedEmail,
    });

    if (subscriber && subscriber.isActive) {
      return {
        success: true,
        message: "You're already subscribed — welcome aboard!",
      };
    }

    const unsubscribeToken = crypto.randomBytes(24).toString('hex');

    if (subscriber) {
      subscriber.isActive = true;
      subscriber.unsubscribeToken = unsubscribeToken;
      subscriber.unsubscribedAt = undefined;
      await subscriber.save();
    } else {
      subscriber = await this.subscriberModel.create({
        email: normalizedEmail,
        source,
        unsubscribeToken,
      });
    }

    const backendUrl = `${process.env.API_PUBLIC_URL || ''}/api/newsletter/unsubscribe/${unsubscribeToken}`;
    this.emailService
      .sendMail(
        normalizedEmail,
        `Welcome to ${APP_NAME} deals`,
        confirmationEmailHtml(backendUrl),
      )
      .catch(() => undefined);

    console.log('✅ Newsletter subscription saved:', normalizedEmail);
    return { success: true, message: "You're subscribed — welcome aboard!" };
  }

  async unsubscribeByToken(token: string): Promise<string> {
    const subscriber = await this.subscriberModel.findOne({
      unsubscribeToken: token,
    });

    if (!subscriber) {
      return unsubscribePageHtml(
        'This unsubscribe link is invalid or has already been used.',
      );
    }

    subscriber.isActive = false;
    subscriber.unsubscribedAt = new Date();
    await subscriber.save();

    return unsubscribePageHtml(
      "You've been unsubscribed from deals and price-drop alerts. Sorry to see you go!",
    );
  }
}
