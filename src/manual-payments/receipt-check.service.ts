/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { getAiService } from '../ai-studio/core/ai.service';

export type ReceiptCheckStatus = 'match' | 'mismatch' | 'unreadable' | 'skipped';

export interface ReceiptCheck {
  status: ReceiptCheckStatus;
  amountRead: number | null;
  referenceRead: string | null;
  note: string;
  checkedAt: Date;
  /** Extra signals read from the screenshot (advisory). */
  payeeRead?: string | null;
  dateRead?: string | null;
  /** Machine-readable warnings: amount_mismatch, not_a_receipt, old_receipt, payee_mismatch, reference_mismatch, edited_looking. */
  flags?: string[];
}

/** What the order/seller account tells us to expect (all optional). */
export interface ReceiptExpectation {
  /** Last digits of the seller's account/number, or the account title, to compare with the payee on the receipt. */
  accountHint?: string | null;
  /** Reference/transaction id the buyer typed, if any. */
  reference?: string | null;
}

export interface ReceiptRead {
  isReceipt?: boolean; amount?: number | string | null; reference?: string | null;
  payee?: string | null; date?: string | null; looksEdited?: boolean;
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    isReceipt: { type: 'boolean' },
    amount: { type: ['number', 'null'], description: 'Transferred amount in PKR' },
    reference: { type: ['string', 'null'], description: 'Transaction / reference id' },
    payee: { type: ['string', 'null'], description: 'Receiving account title or number as shown' },
    date: { type: ['string', 'null'], description: 'Transaction date as ISO yyyy-mm-dd if readable' },
    looksEdited: { type: 'boolean', description: 'True only if the screenshot shows obvious signs of tampering' },
  },
  required: ['isReceipt', 'amount', 'reference', 'payee', 'date', 'looksEdited'],
  additionalProperties: false,
};

/** Pure comparison, kept separate so it can be tested without calling the model. */
export function compareReceiptAmount(amountRead: number | null, expectedPKR: number): { status: ReceiptCheckStatus; note: string } {
  if (amountRead == null || !Number.isFinite(amountRead)) return { status: 'unreadable', note: 'Could not read an amount from the receipt — check it by eye.' };
  const diff = Math.abs(amountRead - expectedPKR);
  // Rounding in banking apps is common; allow 1% (min Rs 5).
  if (diff <= Math.max(5, expectedPKR * 0.01)) return { status: 'match', note: `Receipt shows PKR ${amountRead.toLocaleString()} — matches the order.` };
  return { status: 'mismatch', note: `Receipt shows PKR ${amountRead.toLocaleString()} but the order is PKR ${expectedPKR.toLocaleString()}.` };
}

const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/** Pure: full evaluation of what was read from the receipt vs what we expect. Advisory flags only. */
export function evaluateReceipt(read: ReceiptRead, expectedPKR: number, expected: ReceiptExpectation = {}, now: Date = new Date()): Pick<ReceiptCheck, 'status' | 'note' | 'amountRead' | 'referenceRead' | 'payeeRead' | 'dateRead' | 'flags'> {
  const flags: string[] = [];
  const amount = typeof read.amount === 'number' ? read.amount : Number(String(read.amount ?? '').replace(/[^\d.]/g, '')) || null;
  const base = {
    amountRead: amount, referenceRead: typeof read.reference === 'string' && read.reference ? read.reference : null,
    payeeRead: typeof read.payee === 'string' && read.payee ? read.payee : null, dateRead: typeof read.date === 'string' && read.date ? read.date : null,
  };
  if (read.isReceipt === false) return { ...base, status: 'unreadable', note: 'This does not look like a transfer receipt.', flags: ['not_a_receipt'] };

  const { status: amountStatus, note } = compareReceiptAmount(amount, expectedPKR);
  const notes = [note];
  if (amountStatus === 'mismatch') flags.push('amount_mismatch');

  if (base.dateRead) {
    const d = new Date(base.dateRead);
    if (!Number.isNaN(d.getTime())) {
      const ageDays = (now.getTime() - d.getTime()) / 86_400_000;
      if (ageDays > 7) { flags.push('old_receipt'); notes.push(`The receipt is dated ${base.dateRead}, which is more than a week ago.`); }
      if (ageDays < -1) { flags.push('future_date'); notes.push('The receipt date is in the future.'); }
    }
  }
  if (expected.accountHint && base.payeeRead) {
    const hint = digits(expected.accountHint).slice(-4);
    const payeeDigits = digits(base.payeeRead);
    const textHit = String(base.payeeRead).toLowerCase().includes(String(expected.accountHint).toLowerCase());
    // Receipts usually mask the middle digits, so only compare the last 4 when both sides have them.
    if (hint.length === 4 && payeeDigits.length >= 4 && !payeeDigits.endsWith(hint) && !textHit) {
      flags.push('payee_mismatch'); notes.push('The receiving account on the receipt does not look like your account.');
    }
  }
  if (expected.reference && base.referenceRead && digits(expected.reference) && digits(base.referenceRead) && digits(expected.reference) !== digits(base.referenceRead)) {
    flags.push('reference_mismatch'); notes.push('The reference on the receipt differs from the one the buyer entered.');
  }
  if (read.looksEdited) { flags.push('edited_looking'); notes.push('The image shows signs of editing — verify in your bank app.'); }

  const status: ReceiptCheckStatus = amountStatus === 'unreadable' ? 'unreadable' : flags.length ? 'mismatch' : 'match';
  return { ...base, status, note: notes.join(' '), flags };
}

/**
 * Reads a bank-transfer screenshot with Claude vision and compares it to the order,
 * so the seller is warned before confirming a short, old, unrelated or edited payment. Advisory only —
 * the seller still decides; failures never block the buyer's submission.
 * Goes through the shared AiService when available (kill switch, logging, usage, PII-safe); falls back to a direct call otherwise.
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

  async check(buffer: Buffer, mimeType: string, expectedPKR: number, expected: ReceiptExpectation = {}): Promise<ReceiptCheck> {
    const base = { amountRead: null, referenceRead: null, checkedAt: new Date() };
    const client = this.getClient();
    if (!client || !IMAGE_TYPES.includes(mimeType as ImageType)) {
      return { ...base, status: 'skipped', note: client ? 'Only image receipts are read automatically.' : 'Automatic receipt reading is not enabled.' };
    }
    const prompt = 'This is a customer\'s bank / JazzCash / Easypaisa transfer screenshot. Extract the fields. Set isReceipt=false if it is not a payment receipt. Set looksEdited=true only for obvious tampering (mismatched fonts, pasted numbers).';
    try {
      let read: ReceiptRead | null = null;
      const ai = getAiService();
      if (ai && ai.isAvailable()) {
        if (!(await ai.isFeatureOn('receipt_ocr'))) return { ...base, status: 'skipped', note: 'Automatic receipt reading is turned off.' };
        const r = await ai.generate({
          feature: 'receipt_ocr', tier: 'standard', maxTokens: 400, schema: RECEIPT_SCHEMA, stripPii: false,
          system: 'You read payment receipts accurately and never guess: use null for anything you cannot read.',
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType as ImageType, data: buffer.toString('base64') } },
            { type: 'text', text: prompt },
          ] }],
        });
        read = r.json as ReceiptRead;
      } else {
        const res = await client.messages.create({
          model: process.env.ANTHROPIC_MODEL_FAST || process.env.AI_TEXT_MODEL_STANDARD || 'claude-sonnet-5-5',
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType as ImageType, data: buffer.toString('base64') } },
              { type: 'text', text: `${prompt} Reply with ONLY JSON: {"isReceipt":true|false,"amount":<number or null>,"reference":"<id or null>","payee":"<account or null>","date":"<yyyy-mm-dd or null>","looksEdited":false}` },
            ],
          }],
        });
        const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        read = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      }
      const ev = evaluateReceipt(read ?? {}, expectedPKR, expected);
      return { ...ev, checkedAt: new Date() };
    } catch (err: any) {
      this.logger.warn(`Receipt check failed: ${err?.message}`);
      return { ...base, status: 'skipped', note: 'The receipt could not be read automatically.' };
    }
  }
}
