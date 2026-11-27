/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- mock-heavy */
import mongoose from 'mongoose';
import * as nodemailer from 'nodemailer';
import { sendMail } from './mailer.util';

jest.mock('nodemailer');

const realFetch = global.fetch;
const realEnv = { ...process.env };
const realModels = mongoose.models;

function fakeResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as any;
}

afterEach(() => {
  global.fetch = realFetch;
  process.env = { ...realEnv };
  (mongoose as any).models = realModels;
  jest.clearAllMocks();
});

describe('mailer.util sendMail — sender identity', () => {
  it('uses the admin-configured PlatformConfig.emailConfig over env vars (Brevo path)', async () => {
    process.env.BREVO_API_KEY = 'key123';
    process.env.APP_NAME = 'Jami Raza'; // whatever the env happens to resolve to
    (mongoose as any).models = {
      PlatformConfig: {
        findOne: () => ({
          select: () => ({
            lean: async () => ({
              emailConfig: {
                fromName: 'EDUDEEN',
                fromEmail: 'marketing@edudeen.com',
                replyToEmail: 'marketing@edudeen.com',
              },
            }),
          }),
        }),
      },
    };
    let sentBody: any;
    global.fetch = jest.fn(async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return fakeResponse({ messageId: 'abc' });
    }) as any;

    const id = await sendMail({
      to: 'buyer@example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
    });

    expect(id).toBe('abc');
    expect(sentBody.sender).toEqual({
      name: 'EDUDEEN',
      email: 'marketing@edudeen.com',
    });
    expect(sentBody.replyTo).toEqual({ email: 'marketing@edudeen.com' });
  });

  it('falls back to env vars for whatever the admin has not set', async () => {
    process.env.BREVO_API_KEY = 'key123';
    process.env.APP_NAME = 'Edudeen';
    process.env.SMTP_FROM = 'noreply@edudeen.com';
    (mongoose as any).models = {
      PlatformConfig: {
        findOne: () => ({ select: () => ({ lean: async () => null }) }),
      },
    };
    let sentBody: any;
    global.fetch = jest.fn(async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return fakeResponse({ messageId: 'xyz' });
    }) as any;

    await sendMail({
      to: 'buyer@example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
    });

    expect(sentBody.sender).toEqual({
      name: 'Edudeen',
      email: 'noreply@edudeen.com',
    });
    expect(sentBody.replyTo).toBeUndefined();
  });

  it('falls back to env vars when there is no PlatformConfig model registered at all (e.g. a module not yet loaded)', async () => {
    process.env.BREVO_API_KEY = 'key123';
    process.env.APP_NAME = 'Edudeen';
    process.env.SMTP_FROM = 'noreply@edudeen.com';
    (mongoose as any).models = {};
    let sentBody: any;
    global.fetch = jest.fn(async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return fakeResponse({ messageId: 'xyz' });
    }) as any;

    await sendMail({
      to: 'buyer@example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
    });

    expect(sentBody.sender).toEqual({
      name: 'Edudeen',
      email: 'noreply@edudeen.com',
    });
  });

  it('never breaks outbound mail when the config lookup itself throws', async () => {
    process.env.BREVO_API_KEY = 'key123';
    process.env.APP_NAME = 'Edudeen';
    process.env.SMTP_FROM = 'noreply@edudeen.com';
    (mongoose as any).models = {
      PlatformConfig: {
        findOne: () => {
          throw new Error('db down');
        },
      },
    };
    let sentBody: any;
    global.fetch = jest.fn(async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return fakeResponse({ messageId: 'xyz' });
    }) as any;

    await expect(
      sendMail({ to: 'buyer@example.com', subject: 'Hi', html: '<p>hi</p>' }),
    ).resolves.toBe('xyz');
    expect(sentBody.sender).toEqual({
      name: 'Edudeen',
      email: 'noreply@edudeen.com',
    });
  });

  it('applies the configured sender and reply-to on the SMTP path too (no BREVO_API_KEY)', async () => {
    delete process.env.BREVO_API_KEY;
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'fallback@example.com';
    (mongoose as any).models = {
      PlatformConfig: {
        findOne: () => ({
          select: () => ({
            lean: async () => ({
              emailConfig: {
                fromName: 'EDUDEEN',
                fromEmail: 'marketing@edudeen.com',
                replyToEmail: 'marketing@edudeen.com',
              },
            }),
          }),
        }),
      },
    };
    const sendMailMock = jest.fn().mockResolvedValue({ messageId: 'smtp-1' });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({
      sendMail: sendMailMock,
    });

    const id = await sendMail({
      to: 'buyer@example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
    });

    expect(id).toBe('smtp-1');
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"EDUDEEN" <marketing@edudeen.com>',
        replyTo: 'marketing@edudeen.com',
      }),
    );
  });
});
