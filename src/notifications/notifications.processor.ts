/* eslint-disable prettier/prettier */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { FirebaseAdminService } from 'src/firebase/firebase.config';
import { EmailService } from 'src/otp/services/email.service';
import { QUEUE_NAMES, NOTIFICATION_PUSH_JOB, NOTIFICATION_EMAIL_JOB, NOTIFICATION_CHANNEL_JOB } from 'src/queues/queue.constants';
import { ChannelMessagingService } from './channels/channel-messaging.service';

/**
 * Dispatches queued push/email jobs raised by NotificationsService.notify().
 * Kept off the request path — a slow FCM/SMTP call never blocks the order,
 * payment, or message flow that triggered the notification.
 */
@Processor(QUEUE_NAMES.NOTIFICATIONS)
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    private readonly firebaseAdminService: FirebaseAdminService,
    private readonly emailService: EmailService,
    private readonly channelMessaging: ChannelMessagingService,
  ) {
    super();
  }

  async process(job: Job<any>): Promise<void> {
    switch (job.name) {
      case NOTIFICATION_PUSH_JOB:
        await this.firebaseAdminService.sendToUser(job.data.userId, {
          title: job.data.title,
          body: job.data.body,
          data: job.data.data,
        });
        return;
      case NOTIFICATION_EMAIL_JOB:
        await this.emailService.sendMail(job.data.to, job.data.subject, job.data.html);
        return;
      case NOTIFICATION_CHANNEL_JOB:
        await this.channelMessaging.deliver(job.data);
        return;
      default:
        this.logger.error(`Unknown notification job "${job.name}" — dropping job ${job.id}`);
    }
  }
}
