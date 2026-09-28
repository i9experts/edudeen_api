/**
 * Creates (or resets) one verified login account per role — admin, seller,
 * buyer — so a fresh database can be logged into without going through the
 * OTP email flow. The very first admin can't be created any other way, since
 * POST /api/auth/admin/create-admin itself requires an admin session.
 *
 * Re-running is safe: an existing account with the same email just gets its
 * password reset and is marked verified/active again.
 *
 * Credentials default to the values below; override any of them via env:
 *   SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
 *   SEED_SELLER_EMAIL / SEED_SELLER_PASSWORD
 *   SEED_BUYER_EMAIL / SEED_BUYER_PASSWORD
 *
 * Usage: node --env-file=.env src/scripts/seed-test-accounts.ts
 */
import mongoose from 'mongoose';
import * as bcrypt from 'bcrypt';

const ACCOUNTS = [
  {
    collection: 'admins',
    role: 'admin',
    name: 'Test Admin',
    email: process.env.SEED_ADMIN_EMAIL ?? 'admin@edudeen.test',
    password: process.env.SEED_ADMIN_PASSWORD ?? 'Admin@12345',
  },
  {
    collection: 'sellers',
    role: 'seller',
    name: 'Test Seller',
    email: process.env.SEED_SELLER_EMAIL ?? 'seller@edudeen.test',
    password: process.env.SEED_SELLER_PASSWORD ?? 'Seller@12345',
  },
  {
    collection: 'users',
    role: 'user',
    name: 'Test Buyer',
    email: process.env.SEED_BUYER_EMAIL ?? 'buyer@edudeen.test',
    password: process.env.SEED_BUYER_PASSWORD ?? 'Buyer@12345',
  },
];

async function run() {
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
    console.log(`${acc.role.padEnd(6)} ${action.padEnd(7)} ${email} / ${acc.password}`);
  }

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
