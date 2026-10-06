import { compareReceiptAmount, ReceiptCheckService } from './receipt-check.service';

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