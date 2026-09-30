import 'reflect-metadata';
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method, @typescript-eslint/require-await -- mock-heavy tests */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { SendMessageDto } from './dto/send-message.dto';
import { StartConversationDto } from './dto/start-conversation.dto';
import { ReportDto } from './dto/report.dto';

const OID = (n: number) => `64f0c0ffee0c0ffee0c0ff${String(n).padStart(2, '0')}`;
const BUYER = OID(1), SELLER = OID(2), CONV = OID(3), STORE = OID(4), MSG = OID(5);
const lean = (v: any) => { const r: any = Promise.resolve(v); r.lean = () => Promise.resolve(v); return r; };

function build(over: { conv?: any; blocked?: any; parent?: any; store?: any; product?: any } = {}) {
  const conv = over.conv ?? { _id: CONV, buyerId: BUYER, sellerId: SELLER, storeId: STORE };
  const convModel: any = {
    findById: jest.fn().mockReturnValue(lean(conv)),
    findByIdAndUpdate: jest.fn().mockReturnValue(lean({ ...conv })),
    findOneAndUpdate: jest.fn().mockResolvedValue({ ...conv, save: jest.fn() }),
    updateMany: jest.fn().mockResolvedValue({}),
    exists: jest.fn().mockResolvedValue(null),
  };
  const msgModel: any = {
    create: jest.fn().mockImplementation(async (d: any) => ({ _id: { toString: () => 'm1' }, ...d })),
    findOne: jest.fn().mockReturnValue(lean(over.parent === undefined ? null : over.parent)),
    findById: jest.fn().mockReturnValue(lean(over.parent === undefined ? null : over.parent)),
  };
  const blkModel: any = { exists: jest.fn().mockResolvedValue(over.blocked ?? null), findOne: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) };
  const rptModel: any = { exists: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ _id: 'r1' }) };
  const repos: any = {
    conversationModel: convModel, messageModel: msgModel, blockModel: blkModel, reportModel: rptModel,
    storeModel: { findById: jest.fn().mockResolvedValue(over.store ?? { _id: STORE, sellerId: SELLER, status: 'active', isDelete: false }) },
    productModel: { findOne: jest.fn().mockResolvedValue(over.product ?? null) },
    productVariantModel: { find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) },
    userModel: { exists: jest.fn().mockResolvedValue({ _id: 'x' }) },
    sellerModel: { exists: jest.fn().mockResolvedValue({ _id: 'x' }) },
  };
  const gateway: any = { emitNewMessage: jest.fn(), emitConversationUpdate: jest.fn(), isOnline: jest.fn().mockReturnValue(true) };
  const svc: any = new MessagingService({ repositories: repos } as any, {} as any, { getActiveBenefits: jest.fn().mockResolvedValue(null) } as any, gateway, { notify: jest.fn().mockResolvedValue(undefined) } as any);
  return { svc, repos, convModel, msgModel, blkModel, rptModel };
}
const dto = (over: object = {}): any => ({ type: 'text', text: 'hello', ...over });

describe('DTO validation', () => {
  const errs = async (cls: any, body: object) => (await validate(plainToInstance(cls, body))).map((e) => e.property);

  it('text is capped, attachments must be Cloudinary https URLs and at most 10', async () => {
    expect(await errs(SendMessageDto, { type: 'text', text: 'x'.repeat(4001) })).toContain('text');
    const att = (url: string) => ({ url, publicId: 'p', resourceType: 'image', mimeType: 'image/png' });
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'http://res.cloudinary.com/x', 'https://evil.example/x.png', '//evil.com/x']) {
      expect(await errs(SendMessageDto, { type: 'image', attachments: [att(bad)] })).toContain('attachments');
    }
    expect(await errs(SendMessageDto, { type: 'image', attachments: [att('https://res.cloudinary.com/demo/image/upload/a.png')] })).not.toContain('attachments');
    expect(await errs(SendMessageDto, { type: 'image', attachments: Array.from({ length: 11 }, () => att('https://res.cloudinary.com/demo/a.png')) })).toContain('attachments');
  });

  it('ids on start / report must be real ObjectIds', async () => {
    expect(await errs(StartConversationDto, { storeId: { $ne: 1 } })).toContain('storeId');
    expect(await errs(ReportDto, { targetType: 'user', targetId: 'nope', reason: 'spam' })).toContain('targetId');
  });
});

describe('sendMessage', () => {
  it('rebuilds a reply quote from the REAL parent message, ignoring whatever the client claims', async () => {
    const { svc, msgModel } = build({ parent: { _id: { toString: () => MSG }, text: 'I will refund you', type: 'text', senderId: SELLER, senderRole: 'seller' } });
    await svc.sendMessage(BUYER, 'user', CONV, dto({ replyTo: { messageId: MSG, text: 'FORGED: seller says refund is approved', senderId: SELLER, senderRole: 'seller', type: 'text' } }));
    const stored = msgModel.create.mock.calls[0][0].replyTo;
    expect(stored.text).toBe('I will refund you');
    expect(stored.senderId).toBe(SELLER);
  });

  it('rejects a reply to a message that is not in this conversation', async () => {
    const { svc } = build({ parent: null });
    await expect(svc.sendMessage(BUYER, 'user', CONV, dto({ replyTo: { messageId: MSG } }))).rejects.toThrow(/not found in this conversation/);
  });

  it('a Block row blocks sending even when the mirrored conversation flags say otherwise', async () => {
    const { svc, msgModel } = build({ blocked: { _id: 'b1' } });
    await expect(svc.sendMessage(BUYER, 'user', CONV, dto())).rejects.toBeInstanceOf(ForbiddenException);
    expect(msgModel.create).not.toHaveBeenCalled();
  });

  it('an attachment from a different Cloudinary account is refused', async () => {
    process.env.CLOUDINARY_CLOUD_NAME = 'mycloud';
    const { svc } = build();
    const att = { url: 'https://res.cloudinary.com/othercloud/image/upload/a.png', publicId: 'p', resourceType: 'image', mimeType: 'image/png' };
    await expect(svc.sendMessage(BUYER, 'user', CONV, dto({ type: 'image', text: undefined, attachments: [att] }))).rejects.toThrow(/uploaded through the app/);
    delete process.env.CLOUDINARY_CLOUD_NAME;
  });

  it('only a LIVE product can be shared', async () => {
    const { svc, repos } = build({ product: null });
    await expect(svc.sendMessage(BUYER, 'user', CONV, dto({ type: 'product_share', text: undefined, productShare: { productId: OID(9) } }))).rejects.toBeInstanceOf(NotFoundException);
    expect(repos.productModel.findOne).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', isDelete: false }));
  });
});

describe('conversation start / block / report', () => {
  it('a pending or suspended store cannot receive new conversations', async () => {
    for (const status of ['pending', 'suspended', 'rejected']) {
      const { svc } = build({ store: { _id: STORE, sellerId: SELLER, status, isDelete: false } });
      await expect(svc.startOrGetConversation(BUYER, { storeId: STORE })).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('blocking marks the right side by who is buyer/seller IN the conversation, whatever the account role', async () => {
    const { svc, convModel } = build();
    await svc.blockUser(SELLER, 'user', { targetId: BUYER, targetRole: 'user' }); // a "user"-role account that is the SELLER here
    expect(convModel.updateMany).toHaveBeenCalledWith({ sellerId: SELLER, buyerId: BUYER }, { $set: { blockedBySeller: true } });
    expect(convModel.updateMany).toHaveBeenCalledWith({ buyerId: SELLER, sellerId: BUYER }, { $set: { blockedByBuyer: true } });
  });

  it('blocking an id that is not an account creates no junk Block row', async () => {
    const { svc, repos, blkModel } = build();
    repos.userModel.exists.mockResolvedValue(null);
    repos.sellerModel.exists.mockResolvedValue(null);
    await expect(svc.blockUser(BUYER, 'user', { targetId: OID(8), targetRole: 'user' })).rejects.toBeInstanceOf(NotFoundException);
    expect(blkModel.create).not.toHaveBeenCalled();
  });

  it('a report needs a target the reporter can actually see', async () => {
    const stranger = OID(7);
    const { svc } = build();
    await expect(svc.reportTarget(stranger, 'user', { targetType: 'conversation', targetId: CONV, reason: 'spam' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.reportTarget(stranger, 'user', { targetType: 'user', targetId: SELLER, reason: 'spam' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a participant can report; a duplicate pending report is a 409', async () => {
    const a = build();
    await expect(a.svc.reportTarget(BUYER, 'user', { targetType: 'conversation', targetId: CONV, reason: 'spam' })).resolves.toBeDefined();
    const b = build();
    b.rptModel.exists.mockResolvedValue({ _id: 'existing' });
    await expect(b.svc.reportTarget(BUYER, 'user', { targetType: 'conversation', targetId: CONV, reason: 'spam' })).rejects.toBeInstanceOf(ConflictException);
    expect(b.rptModel.create).not.toHaveBeenCalled();
  });

  void BadRequestException;
});
