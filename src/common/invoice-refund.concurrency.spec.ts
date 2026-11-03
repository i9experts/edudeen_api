/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- integration test */
/**
 * Real-MongoDB tests: atomic invoice refund reservation. Opt-in:
 *   TEST_MONGO_URI='mongodb://127.0.0.1:27018/edudeen_refund_it?replicaSet=rs0' npx jest invoice-refund.concurrency
 */
import mongoose from 'mongoose';
import {
  reserveInvoiceRefund,
  releaseInvoiceRefund,
  invoiceRefundKey,
} from './invoice-refund.util';

const URI = process.env.TEST_MONGO_URI;
// These suites drop their database when done — never point them at anything that isn't a throwaway test DB.
if (URI && !/(_it|test)/i.test(new URL(URI).pathname))
  throw new Error(
    'Refusing to run: the test database name must contain "_it" or "test"',
  );

(URI ? describe : describe.skip)(
  'atomic invoice refund — real MongoDB',
  () => {
    let conn: mongoose.Connection,
      Invoice: mongoose.Model<any>;
    beforeAll(async () => {
      conn = await mongoose.createConnection(URI!).asPromise();
      Invoice = conn.model(
        'Inv',
        new mongoose.Schema({
          amountUSD: Number,
          refundedAmountUSD: { type: Number, default: 0 },
          status: String,
          isDelete: { type: Boolean, default: false },
          refundedAt: Date,
        }),
      );
    });
    beforeEach(() =>
      Invoice.deleteMany({}),
    );
    afterAll(async () => {
      await conn.dropDatabase();
      await conn.close();
    });

    const inv = async () =>
      (await Invoice.create({ amountUSD: 10, status: 'paid' }))._id.toString();

    it('5 concurrent $6 refunds against a $10 invoice: exactly one is reserved, total never exceeds what was paid', async () => {
      const id = await inv();
      const res = await Promise.all(
        Array.from({ length: 5 }, () => reserveInvoiceRefund(Invoice, id, 6)),
      );
      expect(res.filter(Boolean)).toHaveLength(1);
      const after = await Invoice.findById(id).lean();
      expect(after.refundedAmountUSD).toBe(6);
      expect(after.status).toBe('partially_refunded');
    });

    it('two partial refunds that together fit both succeed, and the invoice ends fully refunded', async () => {
      const id = await inv();
      const res = await Promise.all([
        reserveInvoiceRefund(Invoice, id, 4),
        reserveInvoiceRefund(Invoice, id, 6),
      ]);
      expect(res.filter(Boolean)).toHaveLength(2);
      const after = await Invoice.findById(id).lean();
      expect(after.refundedAmountUSD).toBe(10);
      expect(after.status).toBe('refunded');
    });

    it('release restores the invoice when the provider declines', async () => {
      const id = await inv();
      await reserveInvoiceRefund(Invoice, id, 10);
      await releaseInvoiceRefund(Invoice, id, 10);
      const after = await Invoice.findById(id).lean();
      expect(after.refundedAmountUSD).toBe(0);
      expect(after.status).toBe('paid');
    });

    it('cannot refund an unpaid/failed invoice', async () => {
      const failed = (
        await Invoice.create({ amountUSD: 10, status: 'failed' })
      )._id.toString();
      expect(await reserveInvoiceRefund(Invoice, failed, 1)).toBeNull();
    });

    it('the idempotency key differs for a second partial refund of the same amount (the old key collapsed them)', () => {
      expect(invoiceRefundKey('i1', 0, 5)).not.toBe(
        invoiceRefundKey('i1', 5, 5),
      );
      expect(invoiceRefundKey('i1', 0, 5)).toBe(invoiceRefundKey('i1', 0, 5)); // a retry maps to the same key
    });
  },
);
