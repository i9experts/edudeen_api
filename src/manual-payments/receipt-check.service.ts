/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

export type ReceiptCheckStatus = 'match' | 'mismatch' | 'unreadable' | 'skipped';

export interface ReceiptCheck {
  status: ReceiptCheckStatus;
  amountRead: number | null;
  referenceRead: string | null;
  note: string;
  checkedAt: Date;
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

/** Pure comparison, kept separate so it can be tested without calling the model. */
export function compareReceiptAmount(amountRead: number | null, expectedPKR: number): { status: ReceiptCheckStatus; note: string } {
  if (amountRead == null || !Number.isFinite(amountRead)) return { status: 'unreadable', note: 'Could not read an amount from the receipt — check it by eye.' };
  const diff = Math.abs(amountRead - expectedPKR);
  // Rounding in banking apps is common; allow 1% (min Rs 5).
  if (diff <= Math.max(5, expectedPKR * 0.01)) return { status: 'match', note: `Receipt shows PKR ${amountRead.toLocaleString()} — matches the order.` };
  return { status: 'mismatch', note: `Receipt shows PKR ${amountRead.toLocaleString()} but the order is PKR ${expectedPKR.toLocaleString()}.` };
}

/**
 * Reads a bank-transfer screenshot with Claude vision and compares the amount to the order,
 * so the seller is warned before confirming a short or unrelated payment. Advisory only —
 * the seller still decides; failures never block the buyer's submission.
 */
@Injectable()
export class ReceiptCheckService {
  private readonly logger = new Logger(ReceiptCheckService.name);
  private client: Anthropic | null = null;

  private getClient(): Anthropic | null {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return null;
    if (!this.client) this.client = new Anthropic({ apiKey: key, timeout: 30_000, maxRetries: 1 });
    return this.client;
  }

  async check(buffer: Buffer, mimeType: string, expectedPKR: number): Promise<ReceiptCheck> {
    const base = { amountRead: null, referenceRead: null, checkedAt: new Date() };
    const client = this.getClient();
    if (!client || !IMAGE_TYPES.includes(mimeType as ImageType)) {
      return { ...base, status: 'skipped', note: client ? 'Only image receipts are read automatically.' : 'Automatic receipt reading is not enabled.' };
    }
    try {
      const res = await client.messages.create({
        model: process.env.AI_TEXT_MODEL_STANDARD || 'claude-sonnet-5-5',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType as ImageType, data: buffer.toString('base64') } },
            { type: 'text', text: 'This is a customer\'s bank / JazzCash / Easypaisa transfer screenshot. Reply with ONLY JSON: {"amount": <number in PKR or null>, "reference": "<transaction id or null>", "isReceipt": <true|false>}. No other text.' },
          ],
        }],
      });
      const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      if (json.isReceipt === false) return { ...base, status: 'unreadable', note: 'This does not look like a transfer receipt.' };
      const amount = typeof json.amount === 'number' ? json.amount : Number(String(json.amount ?? '').replace(/[^\d.]/g, '')) || null;
      const { status, note } = compareReceiptAmount(amount, expectedPKR);
      return { status, note, amountRead: amount, referenceRead: typeof json.reference === 'string' ? json.reference : null, checkedAt: new Date() };
    } catch (err: any) {
      this.logger.warn(`Receipt check failed: ${err?.message}`);
      return { ...base, status: 'skipped', note: 'The receipt could not be read automatically.' };
    }
  }
}
