/**
 * Changes the login email of ONE existing admin account in place.
 *
 * Safe by design: it updates only the `email` (and `updatedAt`) of the matched admin document, so the _id,
 * role, password hash, permissions, tokenVersion and every record that references the admin by id are
 * untouched. It never creates or deletes an account. It refuses to run if the new email already belongs to
 * another admin, or if the old email does not match exactly one admin. DRY-RUN by default.
 *
 * Usage (from edudeen_api, with MONGO_URI in the environment / .env):
 *   node --env-file=.env --experimental-strip-types src/scripts/change-admin-email.ts \
 *        --from old@example.com --to new@example.com            # shows what would change
 *   node --env-file=.env --experimental-strip-types src/scripts/change-admin-email.ts \
 *        --from old@example.com --to new@example.com --apply    # performs the change
 *
 * Afterwards the admin signs in with the new email and the SAME password. Existing sessions keep working
 * (tokens are tied to the admin id); log out and in again to see the new email.
 */
import mongoose from 'mongoose';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function run() {
  const from = arg('from')?.toLowerCase().trim();
  const to = arg('to')?.toLowerCase().trim();
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;

  if (!from || !to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    console.error('Usage: --from <old email> --to <new email> [--apply]');
    process.exit(1);
  }
  if (from === to) { console.error('Old and new email are the same.'); process.exit(1); }
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const admins = db.collection('admins');

  const matches = await admins.find({ email: from }).project({ email: 1, name: 1, role: 1, isDelete: 1, status: 1 }).toArray();
  if (matches.length !== 1) {
    console.error(`Expected exactly one admin with email "${from}", found ${matches.length}. Nothing changed.`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const clash = await admins.countDocuments({ email: to });
  if (clash > 0) {
    console.error(`Another admin already uses "${to}". Nothing changed (no duplicate admins are created).`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const target = matches[0];
  console.log(`Admin to update: _id=${String(target._id)} name=${target.name ?? '-'} role=${target.role ?? 'admin'}`);
  console.log(`Email: ${from}  ->  ${to}`);
  if (!apply) {
    console.log('DRY RUN - nothing written. Re-run with --apply to perform the change.');
    await mongoose.disconnect();
    return;
  }

  const res = await admins.updateOne({ _id: target._id, email: from }, { $set: { email: to, updatedAt: new Date() } });
  console.log(res.modifiedCount === 1 ? 'Done: email updated (password, role and all other fields unchanged).' : 'No document was modified.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
