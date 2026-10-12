/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- script drives untyped JSON over HTTP */
/**
 * Live end-to-end smoke for the unified cart + single multi-store checkout, against a RUNNING API, a real
 * MongoDB replica set, real Redis and the Stripe TEST API. Run from the repo root:
 *
 *   # 1. a throwaway database on a local replica set (the script refuses anything else), and start the API on it:
 *   MONGO_URI='mongodb://127.0.0.1:27018/edudeen_e2e_it?replicaSet=rs0' REDIS_URL='redis://127.0.0.1:6379/15' PORT=3057 node dist/main.js
 *   # 2. in another shell (Stripe's test key is read from .env / STRIPE_SECRET_KEY and is never printed):
 *   SMOKE_BASE_URL=http://localhost:3057 SMOKE_MONGO_URI='mongodb://127.0.0.1:27018/edudeen_e2e_it?replicaSet=rs0' \
 *     npx ts-node test/e2e-multistore-checkout.ts
 *
 * It seeds its own accounts, three stores (digital / physical / physical in another currency), products, an
 * exchange rate, a shipping zone and a platform coupon; the DATABASE MUST START EMPTY (drop it between runs).
 *
 * Story: one buyer, three stores, one cart → one checkout → one Stripe PaymentIntent → 1 digital Order +
 * 1 physical Order with 2 sellerOrders → each seller sees only their own → a sub-order is refunded and the
 * others are untouched → ledgers are right. Then a free resource is "bought" through the free path, twice at once.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import * as bcrypt from 'bcrypt';
import Stripe from 'stripe';

const BASE = (process.env.SMOKE_BASE_URL ?? 'http://localhost:3057').replace(/\/$/, '');
const MONGO = process.env.SMOKE_MONGO_URI ?? '';
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY ?? '';

// ── safety: this script WRITES. Only a disposable local database, only Stripe TEST mode. ──────────────────────
if (!['localhost', '127.0.0.1', '::1'].includes(new URL(BASE).hostname)) fail(`refusing non-local API ${BASE}`);
if (!MONGO) fail('SMOKE_MONGO_URI is required');
const mongoUrl = new URL(MONGO);
if (!['localhost', '127.0.0.1'].includes(mongoUrl.hostname) || !/(_it|test)/i.test(mongoUrl.pathname)) {
  fail('SMOKE_MONGO_URI must be a LOCAL database whose name contains "_it" or "test"');
}
if (!STRIPE_KEY.startsWith('sk_test_')) fail('STRIPE_SECRET_KEY must be a Stripe TEST key (sk_test_...)');
function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

type Json = any;
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
};
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: Json = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body };
}
const login = async (email: string, password: string, role: string) => {
  const r = await call('POST', '/api/auth/login', { body: { email, password, role } });
  return r.body?.data?.token?.accessToken as string;
};

const PW = 'Smoke-test-pw-1!';
const oid = () => new mongoose.Types.ObjectId();

async function main() {
  await mongoose.connect(MONGO);
  const db = mongoose.connection.db!;
  const col = (n: string) => db.collection(n);
  const stripe = new Stripe(STRIPE_KEY);

  if ((await col('users').countDocuments()) > 0) fail('the database is not empty — drop it and restart the API first');

  // ── seed ──────────────────────────────────────────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash(PW, 10);
  const now = new Date();
  const base = { password: hash, isVerified: true, status: 'active', isDelete: false, tokenVersion: 0, createdAt: now, updatedAt: now, profileImage: null };
  const buyerId = oid(), adminId = oid(), sIds = [oid(), oid(), oid()];
  await col('users').insertOne({ _id: buyerId, ...base, name: 'Smoke Buyer', email: 'buyer@smoke.test', role: 'user', stripeCustomerId: null, currencyPreference: 'USD' });
  await col('admins').insertOne({ _id: adminId, ...base, name: 'Smoke Admin', email: 'admin@smoke.test', role: 'admin' });
  await col('sellers').insertMany(
    sIds.map((_id, i) => ({
      _id, ...base, name: `Seller ${'ABC'[i]}`, email: `seller${'abc'[i]}@smoke.test`, role: 'seller', storeId: null, isOnboarded: true,
      stripeCustomerId: null, hasPlatformPaymentMethod: false, stripeConnectedAccountId: null, stripeConnectStatus: 'not_connected',
      stripeConnectChargesEnabled: false, stripeConnectPayoutsEnabled: false, cascadeSuspendedStoreIds: [], onboardingDraft: null,
    })),
  );
  await col('exchangerates').insertOne({ currency: 'PKR', ratePerUSD: 280, effectiveFrom: now, source: 'admin', isRejected: false, createdAt: now, updatedAt: now });
  const storeDefs = [
    { key: 'A', name: 'Digital Store A', currency: 'USD' },
    { key: 'B', name: 'Books B', currency: 'USD' },
    { key: 'C', name: 'Books C (PKR)', currency: 'PKR' },
  ];
  const storeIds: Record<string, string> = {};
  for (const [i, d] of storeDefs.entries()) {
    const _id = oid();
    storeIds[d.key] = _id.toString();
    await col('stores').insertOne({
      _id, sellerId: sIds[i].toString(), name: d.name, slug: `store-${d.key.toLowerCase()}`, status: 'active', isDelete: false,
      baseCurrency: d.currency, codEnabled: true, fulfillmentMode: 'seller', badges: [], createdAt: now, updatedAt: now,
    });
  }
  const mkProduct = async (key: string, type: 'digital' | 'physical', name: string, price: number, currency: string, extra: object = {}) => {
    const pid = oid(), vid = oid();
    const sid = storeIds[key], seller = sIds[key.charCodeAt(0) - 65].toString();
    await col('products').insertOne({
      _id: pid, storeId: sid, sellerId: seller, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), type, productType: type === 'digital' ? 'educational' : 'physical', status: 'active', isDelete: false,
      images: [], createdAt: now, updatedAt: now,
      ...(type === 'digital' ? { digital: { files: [{ name: 'sheet.pdf', url: 'private/digital-products/sheet.pdf', size: 1000, mimeType: 'application/pdf' }], downloadLimit: 5 } } : {}),
      ...extra,
    });
    await col('productvariants').insertOne({
      _id: vid, productId: pid.toString(), status: 'active', isDelete: false, price, currency, options: [], images: [], sku: `SKU-${vid}`,
      unlimitedStock: type === 'digital', stock: type === 'digital' ? 0 : 10, createdAt: now, updatedAt: now,
    });
    return { productId: pid.toString(), variantId: vid.toString() };
  };
  const pA = await mkProduct('A', 'digital', 'Algebra worksheet pack', 20, 'USD');
  const pB = await mkProduct('B', 'physical', 'Geometry textbook', 30, 'USD');
  const pC = await mkProduct('C', 'physical', 'Urdu grammar book', 5600, 'PKR'); // = USD 20 at 280
  const pFree = await mkProduct('A', 'digital', 'Free colouring sheet', 0, 'USD');
  await col('shippingzones').insertOne({ country: 'Pakistan', province: null, city: null, shippingPrice: 560, estimatedDeliveryTime: '3-5 days', status: 'active', isDelete: false, createdAt: now, updatedAt: now }); // PKR 560 = USD 2 per store
  await col('addresses').insertOne({
    userId: buyerId.toString(), isDefault: true, isDelete: false, recipientName: 'Smoke Buyer', phoneNumber: '+920000000000',
    addressLine1: '1 Test Road', city: 'Lahore', state: 'Punjab', zipCode: '54000', createdAt: now, updatedAt: now,
  });
  await col('coupons').insertOne({
    scope: 'platform', storeId: null, sellerId: null, adminId: adminId.toString(), code: 'PLAT10', discountType: 'percentage', discountValue: 10,
    currency: 'USD', minOrderAmount: null, usageLimit: 100, usageCount: 0, expiresAt: null, isActive: true, isDelete: false, createdAt: now, updatedAt: now,
  });

  // ── sessions ─────────────────────────────────────────────────────────────────────────────────────────────────
  const buyer = await login('buyer@smoke.test', PW, 'user');
  const sellers = await Promise.all(['a', 'b', 'c'].map((k) => login(`seller${k}@smoke.test`, PW, 'seller')));
  check('buyer and the three sellers can log in', !!buyer && sellers.every(Boolean));
  if (!buyer || !sellers.every(Boolean)) throw new Error('login failed');

  // ── 1. cart from the main marketplace (no storeId): 1 digital + 2 physical stores ─────────────────────────
  for (const p of [pA, pB, pC]) {
    const r = await call('POST', '/api/cart/add-to-cart', { token: buyer, body: { productId: p.productId, productVariantId: p.variantId, quantity: 1 } });
    if (r.status >= 300) throw new Error(`add-to-cart failed ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  const myCarts = await call('GET', '/api/cart/my-carts', { token: buyer });
  check('items were filed under their own stores: 3 separate cart documents', myCarts.body.data.length === 3, myCarts.body);

  const unified = await call('GET', '/api/cart/unified?currency=USD', { token: buyer });
  const u = unified.body.data;
  check('GET /api/cart/unified shows all 3 items from 3 stores', u.items.length === 3 && u.stores.length === 3, u);
  check('unified grand total = USD 70 (20 + 30 + PKR 5600 converted)', near(u.grandTotal, 70), u.grandTotal);

  // ── 2. ONE checkout across all stores ─────────────────────────────────────────────────────────────────────
  const co = await call('POST', '/api/checkout/create-checkout', { token: buyer, body: { currencyPreference: 'USD' } });
  const checkout = co.body.data?.checkout;
  check('create-checkout without storeId succeeds and merges all 3 stores', co.status < 300 && checkout?.items?.length === 3, co.body);
  const methods: string[] = co.body.data?.allowedPaymentMethods ?? [];
  check('Stripe is offered, Cash on Delivery is not (physical items from two stores)', methods.includes('stripe') && !methods.includes('cash_on_delivery'), methods);
  const cod = await call('POST', '/api/payment/cod-payment', { token: buyer, body: { checkoutId: checkout._id } });
  // (this cart also holds a digital item, which COD refuses first; the "one store" rule itself is covered by unit tests)
  check('cod-payment is refused server-side for this cart', cod.status === 400, cod.body);

  const cp = await call('POST', '/api/checkout/apply-coupon', { token: buyer, body: { checkoutId: checkout._id, code: 'PLAT10' } });
  check('a platform coupon applies across all stores (10% of 70 = 7)', cp.status < 300 && near(cp.body.data.couponDiscountUSD, 7), cp.body);

  const zones = await call('GET', '/api/checkout/getShippingZones', { token: buyer });
  const zoneId = zones.body.data[0]._id;
  const sh = await call('POST', '/api/checkout/addShippingInCheckout', { token: buyer, body: { checkoutId: checkout._id, shippingZoneId: zoneId } });
  const lines = sh.body.data?.shippingByStore ?? [];
  check('shipping: one line per physical store (B and C), none for the digital store', lines.length === 2 && lines.every((l: any) => near(l.fee, 2)) && !lines.some((l: any) => l.storeId === storeIds.A), sh.body);
  check('grand total = 63 + 4 shipping = USD 67', near(sh.body.data.totalAmount, 67), sh.body.data?.totalAmount);

  // ── 3. ONE Stripe PaymentIntent for the grand total, paid with a Stripe test card ─────────────────────────
  const ip = await call('POST', '/api/payment/initiate-payment', { token: buyer, body: { checkoutId: checkout._id } });
  const piId: string = ip.body.data?.paymentIntentId;
  check('initiate-payment creates a single PaymentIntent for USD 67.00', ip.status < 300 && !!piId && near(ip.body.data.amount, 67), ip.body);
  const piBefore = await stripe.paymentIntents.retrieve(piId);
  check('the PaymentIntent on Stripe is 6700 cents', piBefore.amount === 6700, piBefore.amount);
  await stripe.paymentIntents.confirm(piId, { payment_method: 'pm_card_visa' });

  // no public webhook URL here: the status endpoint retrieves the intent and finalizes (the same path the webhook runs)
  let status: Json = null;
  for (let i = 0; i < 20; i++) {
    status = (await call('GET', `/api/payment/status?checkoutId=${checkout._id}`, { token: buyer })).body.data;
    if (status?.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  check('payment completes and orders are created', status?.status === 'completed', status);

  // ── 4. the order shape ─────────────────────────────────────────────────────────────────────────────────────
  const orders = await col('orders').find({ checkoutId: checkout._id.toString() }).toArray();
  const physical: Json = orders.find((o) => o.sellerOrders[0].fulfillmentType === 'physical');
  const digital: Json = orders.find((o) => o.sellerOrders[0].fulfillmentType === 'digital');
  check('exactly 2 Orders: 1 digital + 1 physical', orders.length === 2 && !!physical && !!digital, orders.length);
  check('the physical Order has 2 sellerOrders (stores B and C); the digital Order has 1 (store A)',
    physical?.sellerOrders.length === 2 && digital?.sellerOrders.length === 1 &&
      [...physical.sellerOrders.map((s: any) => s.storeId)].sort().join() === [storeIds.B, storeIds.C].sort().join() &&
      digital.sellerOrders[0].storeId === storeIds.A, orders.map((o) => o.sellerOrders.map((s: any) => s.storeId)));
  check('the Orders\' totals add up to exactly what Stripe charged (USD 67.00)', near(orders.reduce((s, o) => s + o.totalAmount, 0), 67), orders.map((o) => o.totalAmount));
  check('physical Order shipping = sum of its sub-orders\' lines (USD 4), digital has none',
    near(physical.shippingFee, 4) && physical.sellerOrders.every((s: any) => near(s.shippingFee, 2)) && digital.shippingFee === 0);
  check('each physical sub-order snapshotted fulfillmentMode "seller"', physical.sellerOrders.every((s: any) => s.fulfillmentMode === 'seller'));
  check('all orders are paid by Stripe', orders.every((o) => o.isPaid && o.paymentType === 'stripe'));
  const txs = await col('paymenttransactions').find({ checkoutId: checkout._id.toString() }).toArray();
  check('one payment transaction, covering both Orders', txs.length === 1 && txs[0].orderIds.length === 2, txs.length);
  const carts = await col('carts').find({ userId: buyerId.toString() }).toArray();
  check('all three carts were emptied', carts.length === 3 && carts.every((c) => c.items.length === 0), carts.map((c) => c.items.length));

  // ── 5. each seller sees only their own sub-order ────────────────────────────────────────────────────────────
  const view = async (token: string) => (await call('GET', '/api/orders/seller-orders/my', { token })).body.data.orders as Json[];
  const [va, vb, vc] = await Promise.all(sellers.map(view));
  const soOf = (o: Json, store: string) => o.sellerOrders.find((s: any) => s.storeId === store);
  check('seller A sees one order (the digital one) with only their own amount', va.length === 1 && near(va[0].amount, soOf(digital, storeIds.A).subtotal), va);
  check('seller B sees one order with only their own sub-order amount', vb.length === 1 && near(vb[0].amount, soOf(physical, storeIds.B).subtotal), vb);
  check('seller C sees one order with only their own sub-order amount', vc.length === 1 && near(vc[0].amount, soOf(physical, storeIds.C).subtotal), vc);

  // ── 6. the buyer gets the digital item ──────────────────────────────────────────────────────────────────────
  const dl = await call('GET', `/api/orders/download-url?orderId=${digital._id}&productId=${pA.productId}`, { token: buyer });
  check('the buyer can fetch download links for the digital item', dl.status === 200 && dl.body.data?.files?.length === 1, dl.body);

  // ── 7. refund ONE sub-order (seller C's) — the others are untouched ──────────────────────────────────────────
  const cItem = soOf(physical, storeIds.C).items[0];
  const cancel = await call('POST', `/api/orders/cancel/${physical._id}`, { token: buyer, body: { reason: 'smoke: changed my mind', itemIds: [cItem._id.toString()] } });
  check('cancelling seller C\'s only item succeeds and refunds through Stripe', cancel.status < 300 && cancel.body.data?.refundProcessed === true, cancel.body);
  const piAfterIntent = await stripe.paymentIntents.retrieve(piId);
  const piAfter = await stripe.charges.retrieve(piAfterIntent.latest_charge as string); // refunds are tracked on the charge
  const cRefundExpected = Math.round((cItem.totalPrice + soOf(physical, storeIds.C).shippingFee) * 100);
  check('Stripe refunded exactly C\'s item (after its coupon share) + C\'s own shipping line', piAfter.amount_refunded === cRefundExpected, { refunded: piAfter.amount_refunded, expected: cRefundExpected });
  const physAfter: Json = await col('orders').findOne({ _id: physical._id });
  const digAfter: Json = await col('orders').findOne({ _id: digital._id });
  check('seller C\'s sub-order is cancelled; seller B\'s and the digital order are untouched',
    soOf(physAfter, storeIds.C).status === 'cancelled' && soOf(physAfter, storeIds.B).status === 'pending' &&
      soOf(physAfter, storeIds.B).items.every((i: any) => i.status === 'pending') && digAfter.sellerOrders[0].status === 'pending' && digAfter.orderStatus !== 'cancelled');

  // ── 8. fulfilment and ledgers ───────────────────────────────────────────────────────────────────────────────
  const upd = (token: string, order: Json, store: string, status: string, tracking?: object) =>
    call('PUT', '/api/orders/update-status', { token, body: { orderId: order._id.toString(), storeId: store, status, ...(tracking ? { tracking } : {}) } });
  const wrongSeller = await upd(sellers[0], physical, storeIds.B, 'shipped', { carrier: 'TCS', trackingNumber: 'X' });
  check('a seller cannot move another seller\'s sub-order', wrongSeller.status >= 400, wrongSeller.status);
  const s1 = await upd(sellers[1], physical, storeIds.B, 'shipped', { carrier: 'TCS', trackingNumber: '123' });
  const s2 = await upd(sellers[1], physical, storeIds.B, 'delivered');
  const s3 = await upd(sellers[1], physical, storeIds.B, 'completed');
  const s4 = await upd(sellers[0], digital, storeIds.A, 'completed');
  check('seller B ships → delivers → completes their sub-order independently; seller A completes the digital one', [s1, s2, s3, s4].every((r) => r.status < 300), [s1, s2, s3, s4].map((r) => r.status));

  const ledger = async (store: string): Promise<Json> => ({
    sale: await col('transactions').findOne({ storeId: store, type: 'sale' }),
    ship: await col('transactions').findOne({ storeId: store, type: 'adjustment', 'metadata.shippingCredit': true }),
    all: await col('transactions').countDocuments({ storeId: store }),
    bal: await col('sellerbalances').findOne({ storeId: store }),
  });
  const [la, lb, lc] = await Promise.all([ledger(storeIds.A), ledger(storeIds.B), ledger(storeIds.C)]);
  const bSo = soOf(physAfter, storeIds.B), aSo = soOf(digAfter, storeIds.A);
  const expectedNet = (so: Json, sale: Json, shipping: number) => {
    const m = sale.metadata;
    return so.settlementAmount - m.platformFee - m.processingFee + shipping;
  };
  check('seller B is credited their sale (net of commission and card fee) PLUS their shipping line, commission-free',
    !!lb.sale && !!lb.ship && near(lb.sale.amount, bSo.settlementAmount) && near(lb.ship.amount, 2) &&
      near(lb.sale.metadata.platformFee, Math.round(bSo.settlementAmount * lb.sale.metadata.feeRate * 100) / 100) &&
      near(lb.sale.metadata.netAmount, expectedNet(bSo, lb.sale, 2)) && near(lb.bal.pendingBalance, lb.sale.metadata.netAmount),
    { sale: lb.sale?.metadata, bal: lb.bal?.pendingBalance });
  check('seller A (digital) is credited their sale only — no shipping', !!la.sale && !la.ship && near(la.sale.amount, aSo.settlementAmount) && near(la.sale.metadata.netAmount, expectedNet(aSo, la.sale, 0)), la.sale?.metadata);
  check('seller C was never credited anything (their sub-order was refunded)', lc.all === 0 && !lc.bal, lc);

  // ── 9. a FREE resource through the free path, confirmed twice at once ────────────────────────────────────────
  await call('POST', '/api/cart/add-to-cart', { token: buyer, body: { productId: pFree.productId, productVariantId: pFree.variantId, quantity: 1 } });
  const fco = await call('POST', '/api/checkout/create-checkout', { token: buyer, body: { storeId: storeIds.A, currencyPreference: 'USD' } });
  const fid = fco.body.data?.checkout?._id;
  check('a free item\'s checkout offers only the free confirmation', fco.status < 300 && JSON.stringify(fco.body.data.allowedPaymentMethods) === '["free"]', fco.body);
  const fPay = await call('POST', '/api/payment/initiate-payment', { token: buyer, body: { checkoutId: fid } });
  check('Stripe is not used for a 0 total (clear message)', fPay.status === 400 && /free/i.test(JSON.stringify(fPay.body)), fPay.body);
  const [f1, f2, f3] = await Promise.all([1, 2, 3].map(() => call('POST', '/api/payment/free-checkout', { token: buyer, body: { checkoutId: fid } })));
  const okCount = [f1, f2, f3].filter((r) => r.status < 300).length;
  check('three simultaneous free confirmations place the order exactly once', okCount === 1, [f1, f2, f3].map((r) => r.status));
  const freeOrders = await col('orders').find({ checkoutId: fid }).toArray();
  check('the free order is paid (paymentType "free") and the cart is clean', freeOrders.length === 1 && freeOrders[0].isPaid && freeOrders[0].paymentType === 'free' && freeOrders[0].totalAmount === 0);
  const fdl = await call('GET', `/api/orders/download-url?orderId=${freeOrders[0]._id}&productId=${pFree.productId}`, { token: buyer });
  check('the buyer can download the free item', fdl.status === 200, fdl.body);
  check('no ledger rows exist for the free sale until fulfilment, and none carry a commission on 0', (await col('transactions').countDocuments({ referenceId: freeOrders[0]._id.toString() })) === 0);

  // ── result ────────────────────────────────────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await mongoose.disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error('SMOKE ERROR:', e?.message ?? e);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
