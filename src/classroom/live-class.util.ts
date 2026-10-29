/* eslint-disable prettier/prettier */
import { escapeHtml, notificationEmailShell } from '../notifications/templates/notification-email.template';
import { pktLabel } from '../products/product-schedule-notify.util';
import { paidSeatFilter } from './course.util';

/** Minutes before the start that every buyer and the seller are reminded. */
export const LIVE_REMINDER_OFFSETS = [60, 30, 15, 5] as const;
/** The meeting link opens this many minutes before the start (buyers); the teacher always sees it. */
export const JOIN_OPENS_MINUTES = 30;

/**
 * The reminder a class is due for right now: the smallest offset that is still >= the minutes left
 * (so a missed cron tick sends ONE catch-up reminder, not a burst). null = too early, already started, or nothing left.
 */
export function dueReminderOffset(startsAt: Date | string, now = new Date()): { offset: number; minutesLeft: number } | null {
  const ms = new Date(startsAt).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutesLeft = Math.ceil(ms / 60000);
  const offset = [...LIVE_REMINDER_OFFSETS].reverse().find(o => minutesLeft <= o);
  return offset === undefined ? null : { offset, minutesLeft };
}

/** Distinct buyers holding a seat (paid, not cancelled/refunded). */
export async function liveClassBuyerIds(orderModel: { find: (...a: any[]) => any }, productId: string): Promise<string[]> {
  const orders: any[] = await orderModel.find(paidSeatFilter(productId)).select('userId').lean();
  return [...new Set(orders.map(o => String(o.userId)).filter(Boolean))];
}

const webUrl = () => (process.env.WEB_APP_URL || 'https://www.edudeen.com').replace(/\/$/, '');

export function minutesText(m: number): string {
  if (m >= 60) return m % 60 === 0 ? `${m / 60} hour${m >= 120 ? 's' : ''}` : `${m} minutes`;
  return `${m} minute${m === 1 ? '' : 's'}`;
}

export interface LiveClassMessageInput { name: string; startsAt: Date | string; meetingUrl?: string | null; platform?: string | null; }

/** True once buyers may see the meeting link (JOIN_OPENS_MINUTES before the start). */
export function joinWindowOpen(startsAt: Date | string, now = new Date()): boolean {
  return now.getTime() >= new Date(startsAt).getTime() - JOIN_OPENS_MINUTES * 60000;
}

export const liveEndsAt = (startsAt: Date | string, durationMinutes: number) => new Date(new Date(startsAt).getTime() + (durationMinutes ?? 0) * 60000);

/** upcoming | completed | cancelled, for library and seller views. */
export function liveStatusOf(live: { startsAt: Date | string; durationMinutes: number; status?: string | null } | null | undefined, now = new Date()): 'upcoming' | 'completed' | 'cancelled' | null {
  if (!live?.startsAt) return null;
  if (live.status === 'cancelled') return 'cancelled';
  return liveEndsAt(live.startsAt, live.durationMinutes).getTime() < now.getTime() ? 'completed' : 'upcoming';
}

/** Registration is open until the deadline (or until the class ends when there is none) and never for a cancelled class. */
export function registrationOpen(live: { startsAt: Date | string; durationMinutes: number; status?: string | null; registrationDeadline?: Date | string | null } | null | undefined, now = new Date()): boolean {
  if (!live?.startsAt || live.status === 'cancelled') return false;
  const close = live.registrationDeadline ? new Date(live.registrationDeadline).getTime() : liveEndsAt(live.startsAt, live.durationMinutes).getTime();
  return now.getTime() <= close;
}

export function reminderCopy(kind: 'seller' | 'buyer', c: LiveClassMessageInput, minutesLeft: number) {
  const when = pktLabel(c.startsAt);
  const title = `"${c.name}" starts in ${minutesText(minutesLeft)}`;
  const body = kind === 'seller'
    ? `Your live class starts at ${when}. Be ready to host: open your meeting link a few minutes early.`
    : joinWindowOpen(c.startsAt)
      ? `Your live class starts at ${when}. Join with the link in your email, in My Library or on the class page.`
      : `Your live class starts at ${when}. The meeting link appears in My Library ${JOIN_OPENS_MINUTES} minutes before the start.`;
  return { title, body };
}

export function liveClassEmail(title: string, body: string, c: LiveClassMessageInput, link: { label: string; path: string }) {
  // The link goes into an e-mail only once the join window is open, so mail cannot bypass it.
  const joinLine = c.meetingUrl && joinWindowOpen(c.startsAt) ?`<p>Meeting link: <a href="${escapeHtml(c.meetingUrl)}">${escapeHtml(c.meetingUrl)}</a></p>` : '';
  return { subject: title, html: notificationEmailShell(escapeHtml(title), `<p>${escapeHtml(body)}</p>${joinLine}`, { label: link.label, url: `${webUrl()}${link.path}` }) };
}
