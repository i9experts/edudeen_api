import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ContactSubmission,
  ContactSubmissionDocument,
} from './schemas/contact-submission.schema';
import { CreateContactSubmissionDto, UpdateContactStatusDto } from './dto/contact.dto';
import { EmailService } from '../otp/services/email.service';

const APP_NAME = process.env.APP_NAME || 'Edudeen';

function acknowledgementEmailHtml(name: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>We got your message</title>
<style>
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
  .container { background: #ffffff; border-radius: 10px; padding: 40px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
  .header { text-align: center; margin-bottom: 24px; }
  .header h1 { color: #2c3e50; margin: 0; font-size: 24px; }
  .success { background: #e8f8ee; border-left: 4px solid #22c55e; padding: 15px; margin: 20px 0; border-radius: 4px; }
  .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; color: #888; font-size: 13px; }
</style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>We got your message</h1></div>
    <div class="success">Hi ${name}, thanks for reaching out to ${APP_NAME} — our support team will get back to you soon, usually within 24 hours.</div>
    <div class="footer"><p>© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p></div>
  </div>
</body>
</html>`;
}

@Injectable()
export class ContactService {
  constructor(
    @InjectModel(ContactSubmission.name)
    private readonly contactModel: Model<ContactSubmissionDocument>,
    private readonly emailService: EmailService,
  ) {}

  async submit(dto: CreateContactSubmissionDto) {
    const submission = await this.contactModel.create({
      name: dto.name.trim(),
      email: dto.email.trim().toLowerCase(),
      topic: dto.topic,
      message: dto.message.trim(),
    });

    this.emailService
      .sendMail(
        submission.email,
        `We got your message — ${APP_NAME}`,
        acknowledgementEmailHtml(submission.name),
      )
      .catch(() => undefined);

    return {
      success: true,
      message: "Thanks for reaching out — we'll get back to you soon.",
    };
  }

  async findAll() {
    const submissions = await this.contactModel
      .find()
      .sort({ createdAt: -1 })
      .exec();

    const stats = {
      new: submissions.filter((s) => s.status === 'new').length,
      read: submissions.filter((s) => s.status === 'read').length,
      resolved: submissions.filter((s) => s.status === 'resolved').length,
    };

    return {
      success: true,
      count: submissions.length,
      stats,
      data: submissions,
    };
  }

  async updateStatus(id: string, dto: UpdateContactStatusDto) {
    const submission = await this.contactModel
      .findByIdAndUpdate(id, { status: dto.status }, { new: true })
      .exec();

    if (!submission) {
      throw new NotFoundException('Contact submission not found');
    }

    return {
      success: true,
      message: 'Status updated successfully',
      data: submission,
    };
  }

  async remove(id: string) {
    const submission = await this.contactModel.findByIdAndDelete(id).exec();

    if (!submission) {
      throw new NotFoundException('Contact submission not found');
    }

    return { success: true, message: 'Submission deleted successfully' };
  }
}
