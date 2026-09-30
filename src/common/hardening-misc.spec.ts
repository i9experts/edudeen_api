import 'reflect-metadata';
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method, @typescript-eslint/require-await -- mock-heavy tests */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BadRequestException } from '@nestjs/common';
import { csvCell, csvLine, escapeRegex, searchTerm, plainString, parseDateParam } from './query-safety.util';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ContactService } from '../contact/contact.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateContactSubmissionDto } from '../contact/dto/contact.dto';
import { CreatePurchaseIntentDto } from '../gift-cards/dto/create-purchase-intent.dto';
import { GiftCardsService } from '../gift-cards/gift-cards.service';
import { SubscriptionNotificationsService } from '../subscriptions/subscription-notifications.service';

describe('query-safety.util', () => {
  it('csvCell neutralises formula injection (= + - @ tab CR) and still quotes', () => {
    for (const evil of ['=HYPERLINK("http://evil","x")', '+cmd|calc', '-2+3', '@SUM(A1)', '\tx', '\rx']) {
      expect(csvCell(evil).startsWith(`"'`)).toBe(true);
    }
    expect(csvCell('normal')).toBe('"normal"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('""');
    expect(csvLine(['a', '=1'])).toBe(`"a","'=1"`);
  });

  it('escapeRegex / searchTerm / plainString drop operators, arrays and over-long input', () => {
    expect(new RegExp(escapeRegex('(a+)+$')).test('aaaa')).toBe(false); // matched literally, not as a pattern
    expect(searchTerm({ $ne: 'x' })).toBeUndefined();
    expect(searchTerm(['a'])).toBeUndefined();
    expect(searchTerm('  hi  ')).toBe('hi');
    expect(searchTerm('x'.repeat(500))!.length).toBe(100);
    expect(plainString({ $ne: 'x' })).toBeUndefined();
    expect(plainString('ok')).toBe('ok');
  });

  it('parseDateParam turns bad dates into a 400, not a CastError 500', () => {
    expect(() => parseDateParam('garbage', 'from')).toThrow(BadRequestException);
    expect(() => parseDateParam({ $gt: 1 }, 'from')).toThrow(BadRequestException);
    expect(parseDateParam(undefined, 'from')).toBeUndefined();
    expect(parseDateParam('2026-01-01', 'from')).toBeInstanceOf(Date);
  });
});

describe('activity log', () => {
  const make = (logs: any[] = []) => {
    const activityLogModel: any = {
      find: jest.fn().mockReturnValue({ sort: () => ({ limit: () => ({ lean: async () => logs }), skip: () => ({ limit: () => ({ lean: async () => logs }) }) }) }),
      countDocuments: jest.fn().mockResolvedValue(0),
    };
    const storeModel: any = { findOne: jest.fn().mockResolvedValue({ _id: 's1' }) };
    return { svc: new ActivityLogService({ repositories: { activityLogModel, storeModel } } as any, {} as any), activityLogModel };
  };

  it('exports never emit a live formula: actor names and descriptions are user-influenced', async () => {
    const { svc } = make([{ createdAt: new Date(), category: 'orders', action: 'x', actorName: '=HYPERLINK("http://evil","x")', actorRole: 'seller', description: '+1+1', ip: '1.1.1.1' }]);
    const csv = await svc.exportCsv('seller1', 's1', {});
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csv).toContain(`"'+1+1"`);
    const admin = await svc.adminExportCsv({});
    expect(admin).toContain(`"'=HYPERLINK`);
  });

  it('search is escaped + bounded and limit/page are clamped (was: raw regex, limit=1e6, page<0)', async () => {
    const { svc, activityLogModel } = make();
    await svc.findAll('seller1', 's1', { search: '(a+)+$', limit: '1000000', page: '-5', actorId: { $ne: 'x' } });
    const filter = activityLogModel.find.mock.calls[0][0];
    expect(filter.$or[0].action.$regex).toBe('\\(a\\+\\)\\+\\$');
    expect(filter.actorId).toBeUndefined(); // operator object dropped
  });

  it('an invalid date filter is a 400', async () => {
    const { svc } = make();
    await expect(svc.findAll('seller1', 's1', { from: 'garbage' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.exportCsv('seller1', 's1', { to: 'garbage' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('contact form', () => {
  it('DTO caps: name 100, topic 100, message 5000, email 254', async () => {
    const errs = async (b: object) => (await validate(plainToInstance(CreateContactSubmissionDto, { name: 'a', email: 'a@b.co', topic: 't', message: 'm', ...b }))).map((e) => e.property);
    expect(await errs({ name: 'x'.repeat(101) })).toContain('name');
    expect(await errs({ message: 'x'.repeat(5001) })).toContain('message');
    expect(await errs({ topic: 'x'.repeat(101) })).toContain('topic');
    expect(await errs({})).toEqual([]);
  });

  const make = (recent: number) => {
    const model: any = {
      create: jest.fn().mockImplementation(async (d: any) => d),
      countDocuments: jest.fn().mockResolvedValue(recent),
      find: jest.fn().mockReturnValue({ sort: () => ({ limit: () => ({ exec: async () => [] }) }) }),
      aggregate: jest.fn().mockResolvedValue([{ _id: 'new', n: 3 }]),
    };
    const email: any = { sendMail: jest.fn().mockResolvedValue(true) };
    return { svc: new ContactService(model, email), email, model };
  };

  it('the acknowledgement mail escapes the submitter-controlled name (platform-identity HTML relay)', async () => {
    const { svc, email } = make(1);
    await svc.submit({ name: '<a href="https://evil">Click to claim refund</a>', email: 'victim@x.co', topic: 't', message: 'm' } as any);
    const html = email.sendMail.mock.calls[0][2] as string;
    expect(html).not.toContain('<a href="https://evil">');
    expect(html).toContain('&lt;a href=&quot;https://evil&quot;&gt;');
  });

  it('no acknowledgement mail once an address already had 3 submissions today (mail-bomb relay), but the message is stored', async () => {
    const { svc, email, model } = make(3);
    await svc.submit({ name: 'x', email: 'victim@x.co', topic: 't', message: 'm' } as any);
    expect(model.create).toHaveBeenCalled();
    expect(email.sendMail).not.toHaveBeenCalled();
  });

  it('admin list is bounded and stats come from a grouped count', async () => {
    const { svc, model } = make(0);
    const res: any = await svc.findAll();
    expect(model.aggregate).toHaveBeenCalled();
    expect(res.stats).toEqual({ new: 3, read: 0, resolved: 0 });
  });
});

describe('email templates escape user-controlled values', () => {
  it('gift card email: recipient name, message and store name cannot inject HTML; subject has no line breaks', async () => {
    const sendMail = jest.fn().mockResolvedValue(true);
    const svc: any = Object.create(GiftCardsService.prototype);
    svc.emailService = { sendMail };
    await svc.sendGiftCardEmail('to@x.co', '<b>Bob</b>', 'Evil<script>x</script>Store', 'GC-1', 'USD', 50, '<a href="http://p">click</a>\r\nBcc: a@b.c');
    const [, subject, html] = sendMail.mock.calls[0];
    expect(html).not.toMatch(/<script|<b>Bob|<a href/);
    expect(subject).not.toMatch(/[\r\n]/);
    expect(html).toContain('&lt;b&gt;Bob&lt;/b&gt;');
  });

  it('subscription emails escape store and customer names', async () => {
    const svc: any = Object.create(SubscriptionNotificationsService.prototype);
    const send = jest.fn().mockResolvedValue(undefined);
    svc.send = send;
    await svc.sendProrationCharged('to@x.co', { customerName: '<img src=x onerror=alert(1)>', storeName: '<a href=//evil>Shop</a>', fromPlanName: 'A', toPlanName: 'B', fromInterval: 'monthly', toInterval: 'yearly', amountUSD: 5 });
    const html = send.mock.calls[0][2] as string;
    expect(html).not.toMatch(/<img src=x|<a href=\/\/evil/);
  });
});

describe('device tokens', () => {
  const make = (existing = 12) => {
    const deviceTokenModel: any = {
      findOneAndUpdate: jest.fn().mockResolvedValue({}),
      find: jest.fn().mockReturnValue({ sort: () => ({ skip: () => ({ select: () => ({ lean: async () => Array.from({ length: Math.max(0, existing - 10) }, (_, i) => ({ _id: `old${i}` })) }) }) }) }),
      deleteMany: jest.fn().mockResolvedValue({}),
    };
    const svc: any = Object.create(NotificationsService.prototype);
    svc.databaseService = { repositories: { deviceTokenModel } };
    return { svc, deviceTokenModel };
  };

  it('keeps at most 10 devices per account (oldest dropped)', async () => {
    const { svc, deviceTokenModel } = make(12);
    await svc.registerDeviceToken('u1', 'user', 'tok', 'android');
    expect(deviceTokenModel.deleteMany).toHaveBeenCalledWith({ _id: { $in: ['old0', 'old1'] } });
  });

  it('rejects an empty or oversized token', async () => {
    const { svc } = make();
    await expect(svc.registerDeviceToken('u1', 'user', '', 'ios')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.registerDeviceToken('u1', 'user', 'x'.repeat(1025), 'ios')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('gift card purchase DTO', () => {
  it('caps amount, recipient name and message', async () => {
    const errs = async (b: object) => (await validate(plainToInstance(CreatePurchaseIntentDto, { amount: 10, ...b }))).map((e) => e.property);
    expect(await errs({ amount: 1e9 })).toContain('amount');
    expect(await errs({ recipientName: 'x'.repeat(81) })).toContain('recipientName');
    expect(await errs({ message: 'x'.repeat(301) })).toContain('message');
    expect(await errs({})).toEqual([]);
  });
});
