import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import { normalizeRequestPath } from 'src/common/request-path.util';

/** First path segments that never mean "data changed" for other screens. */
const IGNORED = new Set(['auth', 'realtime', 'health', 'upload', 'webhooks-test', 'seo', 'newsletter']);

/** A write on one of these also changes the listed topics (the screens that show the result). */
const ALIASES: Record<string, string[]> = {
  payment: ['orders', 'finance', 'notifications'],
  checkout: ['orders', 'finance', 'cart'],
  webhooks: ['orders', 'finance', 'premium', 'subscriptions'],
  stripe: ['orders', 'finance'],
  'manual-payments': ['orders', 'finance'],
  returns: ['orders', 'finance'],
  refunds: ['orders', 'finance'],
  products: ['catalog'],
  inventory: ['catalog', 'products'],
  variants: ['catalog', 'products'],
  bundles: ['catalog'],
  categories: ['catalog'],
  marketplace: ['catalog', 'products'],
  marketing: ['campaigns', 'catalog', 'config'],
  campaigns: ['marketing', 'catalog', 'config'],
  banners: ['config'],
  spotlight: ['config'],
  'home-cards': ['config'],
  'platform-config': ['config'],
  'admin-config': ['config'],
  'onboarding-slides': ['config'],
  'social-links': ['config'],
  'platform-plans': ['plans', 'config'],
  'store-banner': ['store'],
  'store-theme': ['store'],
  'store-pages': ['store'],
  'store-blog': ['store'],
  stores: ['store'],
  'platform-addons': ['plans'],
  rating: ['reviews', 'catalog'],
  reviews: ['reviews', 'catalog'],
};

/**
 * Topics whose data is PUBLIC (what any visitor can already read): they go to every connected client.
 * Everything else is private and only goes to the rooms it concerns (the admin room, the user who did it,
 * and the stores / buyers involved), so a busy platform does not wake every browser for every order.
 */
const PUBLIC_TOPICS = new Set(['catalog', 'products', 'config', 'banners', 'spotlight', 'home-cards', 'campaigns', 'categories', 'reviews', 'plans', 'bundles', 'announcements', 'faqs', 'learning-paths']);

/** Everything a signed-in user's private screens may show; sent to a user when they receive a notification. */
export const PRIVATE_TOPICS = [
  'orders', 'finance', 'returns', 'refunds', 'customers', 'analytics', 'marketing', 'messaging', 'messages', 'cart', 'wishlist',
  'premium', 'subscriptions', 'reviews', 'plans', 'users', 'payouts', 'loyalty', 'quotes', 'product-questions', 'promotions', 'children', 'store',
];

const HEX24 = /^[0-9a-f]{24}$/;

export const adminRoom = 'admin';
export const userRoom = (id: string) => `user:${id}`;
export const storeRoom = (id: string) => `store:${id}`;

/**
 * Tells connected screens "something changed in <topic>" so they re-read it. Carries NO data (only a topic name);
 * each client re-reads with its own token and therefore only ever sees what it is allowed to see.
 * Routing: public topics -> everyone; private topics -> the rooms listed by the caller.
 */
@Injectable()
export class RealtimeService {
  /** Lets code that has no DI access (Mongoose schema hooks) reach the running service. */
  static instance: RealtimeService | null = null;

  private server: Server | null = null;
  /** room ('*' = everyone) -> topics waiting to be sent */
  private pending = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | null = null;

  attach(server: Server) {
    this.server = server;
    RealtimeService.instance = this;
  }

  /** Topics a write to `path` affects. */
  topicsForPath(rawPath: string): string[] {
    const path = normalizeRequestPath(rawPath ?? '');
    if (!path) return [];
    const segs = path.split('/').filter(Boolean); // ['api', 'admin', 'finance', ...]
    if (segs[0] !== 'api' || segs.length < 2) return [];
    const out = new Set<string>();
    const add = (s?: string) => {
      if (!s || HEX24.test(s) || s.length > 40) return;
      out.add(s);
      (ALIASES[s] ?? []).forEach((a) => out.add(a));
    };
    if (IGNORED.has(segs[1])) return [];
    add(segs[1]);
    // /api/admin/<x>, /api/seller/<x>, /api/public/<x>: the real subject is the next segment.
    if (['admin', 'seller', 'public'].includes(segs[1])) {
      out.delete(segs[1]);
      add(segs[2]);
      if (segs[3] && !HEX24.test(segs[3])) add(segs[3]);
    }
    return [...out];
  }

  /** Called after a successful write request: works out who must hear about it. */
  publishFromRequest(req: any) {
    const raw: string = req.originalUrl?.split('?')[0] ?? req.path ?? '';
    const topics = this.topicsForPath(raw);
    if (!topics.length) return;
    const rooms = new Set<string>([adminRoom]);
    // The person who made the change (their other devices / tabs).
    if (req.user?.userId) rooms.add(userRoom(String(req.user.userId)));
    // Stores named in the path, query or body (a seller screen working on its own store).
    const ids = new Set<string>();
    (normalizeRequestPath(raw) ?? '').split('/').forEach((s) => HEX24.test(s) && ids.add(s));
    for (const src of [req.query, req.body]) {
      const sid = src?.storeId;
      if (typeof sid === 'string' && HEX24.test(sid)) ids.add(sid);
    }
    ids.forEach((id) => rooms.add(storeRoom(id)));
    this.route(topics, [...rooms]);
  }

  /** Sends public topics to everyone and private ones to `rooms`. */
  route(topics: string[], rooms: string[]) {
    const pub = topics.filter((t) => PUBLIC_TOPICS.has(t));
    const priv = topics.filter((t) => !PUBLIC_TOPICS.has(t));
    if (pub.length) this.queue('*', pub);
    if (priv.length) rooms.forEach((r) => this.queue(r, priv));
    // Private topics that also change something public (e.g. an order lowers stock) are covered by their own aliases.
  }

  private queue(room: string, topics: string[]) {
    let set = this.pending.get(room);
    if (!set) this.pending.set(room, (set = new Set()));
    topics.forEach((t) => set!.add(t));
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 400);
    this.timer.unref?.();
  }

  private flush() {
    const batch = this.pending;
    this.pending = new Map();
    this.timer = null;
    try {
      const at = Date.now();
      batch.forEach((topics, room) => {
        const payload = { topics: [...topics], at };
        if (room === '*') this.server?.emit('changed', payload);
        else this.server?.to(room).emit('changed', payload);
      });
    } catch {
      /* a failed broadcast must never affect a request */
    }
  }

  /** For code that changes data outside an HTTP request (cron jobs). Public topics only reach everyone. */
  emit(...topics: string[]) {
    const all = new Set<string>();
    topics.forEach((t) => {
      all.add(t);
      (ALIASES[t] ?? []).forEach((a) => all.add(a));
    });
    this.route([...all], [adminRoom]);
  }

  /** Tell specific users / stores (private topics). */
  emitTo(target: { users?: string[]; stores?: string[]; admin?: boolean }, topics: string[]) {
    const rooms: string[] = [];
    (target.users ?? []).forEach((u) => u && rooms.push(userRoom(String(u))));
    (target.stores ?? []).forEach((s) => s && rooms.push(storeRoom(String(s))));
    if (target.admin !== false) rooms.push(adminRoom);
    this.route(topics, rooms);
  }
}
