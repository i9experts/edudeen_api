/**
 * Creates (or resets) one verified login account per role — admin, seller,
 * buyer — so a fresh database can be logged into without going through the
 * OTP email flow. The very first admin can't be created any other way, since
 * POST /api/auth/admin/create-admin itself requires an admin session.
 *
 * Re-running is safe: an existing account with the same email just gets its
 * password reset and is marked verified/active again.
 *
 * Passwords are never hardcoded: set them via env, otherwise a random one is
 * generated and printed ONCE. Refuses to run with NODE_ENV=production unless
 * SEED_ALLOW_PRODUCTION=true (it resets existing accounts' passwords).
 * Override via env:
 *   SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
 *   SEED_SELLER_EMAIL / SEED_SELLER_PASSWORD
 *   SEED_BUYER_EMAIL / SEED_BUYER_PASSWORD
 *
 * Usage: node --env-file=.env src/scripts/seed-test-accounts.ts
 */
import mongoose from 'mongoose';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

const generated = new Set<string>();
function passwordFrom(envValue: string | undefined, role: string): string {
  if (envValue) return envValue;
  generated.add(role);
  return randomBytes(12).toString('base64url');
}

const ACCOUNTS = [
  {
    collection: 'admins',
    role: 'admin',
    name: 'Test Admin',
    email: process.env.SEED_ADMIN_EMAIL ?? 'admin@edudeen.test',
    password: passwordFrom(process.env.SEED_ADMIN_PASSWORD, 'admin'),
  },
  {
    collection: 'sellers',
    role: 'seller',
    name: 'Test Seller',
    email: process.env.SEED_SELLER_EMAIL ?? 'seller@edudeen.test',
    password: passwordFrom(process.env.SEED_SELLER_PASSWORD, 'seller'),
  },
  {
    collection: 'users',
    role: 'user',
    name: 'Test Buyer',
    email: process.env.SEED_BUYER_EMAIL ?? 'buyer@edudeen.test',
    password: passwordFrom(process.env.SEED_BUYER_PASSWORD, 'user'),
  },
];

async function run() {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PRODUCTION !== 'true') {
    console.error('Refusing to seed test accounts with NODE_ENV=production (set SEED_ALLOW_PRODUCTION=true to override).');
    process.exit(1);
  }
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');

  for (const acc of ACCOUNTS) {
    const email = acc.email.toLowerCase().trim();
    const hashedPassword = await bcrypt.hash(acc.password, 10);
    const now = new Date();

    const res = await db.collection(acc.collection).updateOne(
      { email },
      {
        $set: {
          password: hashedPassword,
          isVerified: true,
          status: 'active',
          isDelete: false,
          updatedAt: now,
        },
        $unset: { otp: '', otpExpiresAt: '' },
        $setOnInsert: {
          name: acc.name,
          email,
          role: acc.role,
          profileImage: null,
          tokenVersion: 0,
          createdAt: now,
          ...(acc.role === 'seller'
            ? {
                storeId: null,
                isOnboarded: false,
                stripeCustomerId: null,
                hasPlatformPaymentMethod: false,
                stripeConnectedAccountId: null,
                stripeConnectStatus: 'not_connected',
                stripeConnectChargesEnabled: false,
                stripeConnectPayoutsEnabled: false,
                cascadeSuspendedStoreIds: [],
                onboardingDraft: null,
              }
            : {}),
          ...(acc.role === 'user' ? { stripeCustomerId: null, currencyPreference: null } : {}),
        },
      },
      { upsert: true },
    );

    const action = res.upsertedCount ? 'created' : 'reset';
    console.log(`${acc.role.padEnd(6)} ${action.padEnd(7)} ${email} / ${generated.has(acc.role) ? acc.password : '(password from env)'}`);
  }

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
