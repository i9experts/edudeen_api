import 'reflect-metadata';
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { SellerStartConversationDto } from './dto/seller-start-conversation.dto';

const OID = (n: number) => `64f0c0ffee0c0ffee0c0ff${String(n).padStart(2, '0')}`;
const BUYER = OID(1), SELLER = OID(2), STORE = OID(4), CONV = OID(7);

function build(over: { student?: boolean; blocked?: boolean; owner?: string; testOnly?: boolean } = {}) {
  const convModel: any = { findOneAndUpdate: jest.fn().mockResolvedValue({ _id: CONV, save: jest.fn() }), find: jest.fn() };
  const repos: any = {
    conversationModel: convModel,
    messageModel: { create: jest.fn() },
    blockModel: { findOne: jest.fn().mockResolvedValue(over.blocked ? { _id: 'b' } : null) },
    storeModel: { findById: jest.fn().mockResolvedValue({ _id: STORE, sellerId: over.owner ?? SELLER, isDelete: false, status: 'active' }) },
    orderModel: { find: jest.fn(() => ({ select: () => ({ limit: () => ({ lean: async () => (over.student === false ? [] : [{ sellerOrders: [{ storeId: STORE, items: [{ productId: 'p1', type: 'digital', status: 'delivered' }] }] }]) }) }) })) },
    productModel: { exists: jest.fn().mockResolvedValue(over.testOnly ? null : { _id: 'p1' }) },
  };
  const gateway: any = { emitNewMessage: jest.fn() };
  const notify = jest.fn();
  const svc: any = new MessagingService({ repositories: repos } as any, {} as any, gateway, { notify } as any);
  return { svc, repos, convModel, gateway, notify };
}

describe('sellerStartConversation', () => {
  it('another seller gets 403 and nothing is created', async () => {
    const { svc, convModel } = build({ owner: OID(9) });
    await expect(svc.sellerStartConversation(SELLER, { storeId: STORE, buyerId: BUYER })).rejects.toBeInstanceOf(ForbiddenException);
    expect(convModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('a buyer who is not a student of this store = 404', async () => {
    const { svc, convModel } = build({ student: false });
    await expect(svc.sellerStartConversation(SELLER, { storeId: STORE, buyerId: BUYER })).rejects.toBeInstanceOf(NotFoundException);
    expect(convModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('a student of test products only = 404', async () => {
    const { svc, convModel } = build({ testOnly: true });
    await expect(svc.sellerStartConversation(SELLER, { storeId: STORE, buyerId: BUYER })).rejects.toBeInstanceOf(NotFoundException);
    expect(convModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('cannot message yourself; a block either way is refused', async () => {
    await expect(build().svc.sellerStartConversation(SELLER, { storeId: STORE, buyerId: SELLER })).rejects.toBeInstanceOf(BadRequestException);
    await expect(build({ blocked: true }).svc.sellerStartConversation(SELLER, { storeId: STORE, buyerId: BUYER })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('student rule is scoped to THIS store, digital, paid/free, not cancelled/refunded', async () => {
    const { svc, repos } = build();
    await svc.sellerStartConversation(SELLER, { storeId: STORE, buyerId: BUYER });
    const f = repos.orderModel.find.mock.calls[0][0];
    expect(f.userId).toBe(BUYER);
    expect(f.$or).toEqual([{ isPaid: true }, { isFreeClaim: true }]);
    const so = f.sellerOrders.$elemMatch;
    expect(so.storeId).toBe(STORE);
    expect(so.items.$elemMatch.type.$in).toEqual(['digital', 'educational']);
    expect(so.items.$elemMatch.status.$nin).toEqual(['cancelled', 'refunded']);
  });

  it('twice = same unique key upsert (setOnInsert only), no message, no notification', async () => {
    const { svc, convModel, repos, gateway, notify } = build();
    const a = await svc.sellerStartConversation(SELLER, { storeId: STORE, buyerId: BUYER });
    const b = await svc.sellerStartConversation(SELLER, { storeId: STORE, buyerId: BUYER });
    expect(a.conversationId).toBe(CONV);
    expect(b.conversationId).toBe(a.conversationId);
    for (const call of convModel.findOneAndUpdate.mock.calls) {
      expect(call[0]).toEqual({ buyerId: BUYER, storeId: STORE });
      expect(Object.keys(call[1])).toEqual(['$setOnInsert']);
      expect(call[1].$setOnInsert.startedBySeller).toBe(true);
      expect(call[2]).toMatchObject({ upsert: true });
    }
    expect(repos.messageModel.create).not.toHaveBeenCalled();
    expect(gateway.emitNewMessage).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('buyer inbox hides a seller-opened thread that has no message yet', async () => {
    const { svc, convModel } = build();
    convModel.find.mockReturnValue({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }) });
    convModel.countDocuments = jest.fn().mockResolvedValue(0);
    svc.db.repositories.userModel = { find: () => ({ select: () => ({ lean: async () => [] }) }) };
    svc.db.repositories.storeModel.find = () => ({ select: () => ({ lean: async () => [] }) });
    await svc.getConversations(BUYER, 'user', {});
    const filter = convModel.find.mock.calls[0][0];
    expect(filter).toMatchObject({ buyerId: BUYER, deletedByBuyer: false });
    expect(filter.$nor).toEqual([{ startedBySeller: true, lastMessage: null }]);
  });

  it('dto needs real ObjectIds', async () => {
    const errs = async (b: object) => (await validate(plainToInstance(SellerStartConversationDto, b))).map(e => e.property);
    expect(await errs({ storeId: 'x', buyerId: { $ne: 1 } })).toEqual(expect.arrayContaining(['storeId', 'buyerId']));
    expect(await errs({ storeId: STORE, buyerId: BUYER })).toEqual([]);
  });
});
