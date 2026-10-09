import { buildReceiptExpectation, compareReceiptAmount, evaluateReceipt, ReceiptCheckService } from './receipt-check.service';

describe('receipt check', () => {
  it('matches within 1% rounding', () => {
    expect(compareReceiptAmount(1000, 1000).status).toBe('match');
    expect(compareReceiptAmount(995, 1000).status).toBe('match');
  });
  it('flags a short or unrelated amount', () => {
    expect(compareReceiptAmount(500, 1000).status).toBe('mismatch');
  });
  it('reports unreadable when no amount was found', () => {
    expect(compareReceiptAmount(null, 1000).status).toBe('unreadable');
  });
  it('skips (never throws) when AI is not configured or the file is not an image', async () => {
    const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    const svc = new ReceiptCheckService();
    expect((await svc.check(Buffer.from('x'), 'image/png', 100)).status).toBe('skipped');
    process.env.ANTHROPIC_API_KEY = 'x';
    expect((await new ReceiptCheckService().check(Buffer.from('x'), 'application/pdf', 100)).status).toBe('skipped');
    if (saved) process.env.ANTHROPIC_API_KEY = saved; else delete process.env.ANTHROPIC_API_KEY;
  });
});

describe('receipt expectation (seller hints + buyer reference)', () => {
  const dp = { accountNumber: '0123456789', jazzcashNumber: '03001234567', accountTitle: 'Ali Traders' };
  it('builds hints from every seller account and the reference', () => {
    const e = buildReceiptExpectation(dp, 'TX-991');
    expect(e.accountHints).toContain('0123456789');
    expect(e.reference).toBe('TX-991');
    expect(buildReceiptExpectation(null, null).reference).toBeNull();
  });
  it('payee matches any of the seller accounts (no false mismatch)', () => {
    const e = buildReceiptExpectation(dp, null);
    expect(evaluateReceipt({ isReceipt: true, amount: 100, payee: '****4567' }, 100, e).flags).not.toContain('payee_mismatch');
    expect(evaluateReceipt({ isReceipt: true, amount: 100, payee: '****6789' }, 100, e).flags).not.toContain('payee_mismatch');
  });
  it('flags a payee that matches none of them, and a different reference', () => {
    const e = buildReceiptExpectation(dp, 'TX-991');
    const ev = evaluateReceipt({ isReceipt: true, amount: 100, payee: '****0000', reference: 'TX-123' }, 100, e);
    expect(ev.flags).toEqual(expect.arrayContaining(['payee_mismatch', 'reference_mismatch']));
  });
});