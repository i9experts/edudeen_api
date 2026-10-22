/**
 * Sets a new password for ONE existing admin/owner account (admins have no e-mail reset by design).
 *
 * Touches only that account: password hash, tokenVersion (+1, every open session ends), sign-in lock and
 * failed-code counters. Never creates/deletes accounts. DRY-RUN by default.
 *
 * Usage (from edudeen_api, MONGO_URI in .env). The new password is read from the environment so it does not
 * land in shell history:
 *   $env:NEW_ADMIN_PASSWORD='...12+ chars...'
 *   node --env-file=.env --experimental-strip-types src/scripts/reset-admin-password.ts --email owner@example.com
 *   node --env-file=.env --experimental-strip-types src/scripts/reset-admin-password.ts --email owner@example.com --apply
 * If the admin sign-in is e-mail/Redis locked, wait 15 minutes or delete the Redis key admin-login-fail:<email>.
 */
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function run() {
  const email = arg('email')?.toLowerCase().trim();
  const apply = process.argv.includes('--apply');
  const password = process.env.NEW_ADMIN_PASSWORD ?? '';
  const uri = process.env.MONGO_URI;
  if (!email) { console.error('Usage: --email <admin email> [--apply]  (new password in NEW_ADMIN_PASSWORD)'); process.exit(1); }
  if (password.length < 12 || password.length > 72 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    console.error('NEW_ADMIN_PASSWORD must be 12-72 characters with letters and numbers.'); process.exit(1);
  }
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const admins = db.collection('admins');
  const matches = await admins.find({ email, isDelete: { $ne: true } }).project({ email: 1, name: 1, isStaff: 1 }).toArray();
  if (matches.length !== 1) {
    console.error(`Expected exactly one admin with email "${email}", found ${matches.length}. Nothing changed.`);
    await mongoose.disconnect(); process.exit(1);
  }
  const t = matches[0];
  console.log(`Admin: _id=${String(t._id)} name=${t.name ?? '-'} ${t.isStaff ? '(staff)' : '(owner)'}`);
  if (!apply) { console.log('DRY RUN - nothing written. Re-run with --apply.'); await mongoose.disconnect(); return; }
  const hash = await bcrypt.hash(password, 12);
  const res = await admins.updateOne(
    { _id: t._id },
    { $set: { password: hash, totpFailures: 0, totpLockedUntil: null, updatedAt: new Date() }, $inc: { tokenVersion: 1 } },
  );
  console.log(res.modifiedCount === 1 ? 'Done: password changed, all sessions of this admin ended.' : 'No document was modified.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
