// Real-MongoDB concurrency check for live-class seats (src/classroom/live-seats.util.ts).
// Standalone on purpose: the MongoDB driver's handshake fails inside Jest's sandbox on this machine.
//   TEST_MONGO_URI=mongodb://127.0.0.1:27998 node scripts/test-live-seats-mongo.cjs     (a standalone mongod is enough)
// Uses a throw-away database and drops it at the end. NEVER point it at the live database.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const uri = process.env.TEST_MONGO_URI;
if (!uri) { console.error('Set TEST_MONGO_URI to a throw-away mongod (not the live database).'); process.exit(2); }

const root = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'seats-'));
execFileSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), path.join(root, 'src/classroom/live-seats.util.ts'), '--outDir', out, '--module', 'commonjs', '--target', 'es2021', '--experimentalDecorators', '--emitDecoratorMetadata', '--skipLibCheck', '--esModuleInterop'], { stdio: 'inherit', cwd: root });
module.paths.unshift(path.join(root, 'node_modules'));
process.env.NODE_PATH = path.join(root, 'node_modules');
require('module').Module._initPaths();
const { claimLiveSeats, releaseLiveSeats } = require(path.join(out, 'live-seats.util.js'));
const mongoose = require(path.join(root, 'node_modules', 'mongoose'));

(async () => {
  const conn = await mongoose.createConnection(uri, { dbName: `seats_${Date.now()}`, serverSelectionTimeoutMS: 4000 }).asPromise();
  const Product = conn.model('P', new mongoose.Schema({}, { strict: false }), 'products');
  const Order = conn.model('O', new mongoose.Schema({}, { strict: false }), 'orders');
  const mk = async (liveSession) => String((await Product.create({ name: 'Live', deliveryFormat: 'live_class', liveSession }))._id);
  const line = (productId, quantity = 1) => ({ productId, quantity, type: 'digital' });
  const taken = async (id) => (await Product.findById(id).lean()).liveSession.seatsTaken;
  let n = 0;
  const ok = (name) => console.log(`  ok ${++n} - ${name}`);
  try {
    let id = await mk({ capacity: 5, seatsTaken: 0, status: 'scheduled', durationMinutes: 60, startsAt: new Date() });
    let res = await Promise.allSettled(Array.from({ length: 50 }, () => claimLiveSeats(Product, Order, [line(id)])));
    assert.strictEqual(res.filter((r) => r.status === 'fulfilled').length, 5);
    assert.strictEqual(await taken(id), 5);
    ok('50 simultaneous buyers for 5 seats: exactly 5 win, counter = 5');

    id = await mk({ capacity: 4, seatsTaken: 3, status: 'scheduled', durationMinutes: 60, startsAt: new Date() });
    await assert.rejects(claimLiveSeats(Product, Order, [line(id, 2)]), /full/);
    await releaseLiveSeats(Product, [line(id)]);
    assert.strictEqual((await claimLiveSeats(Product, Order, [line(id, 2)])).length, 1);
    assert.strictEqual(await taken(id), 4);
    ok('a 2-seat claim that does not fit is refused whole; a released seat can be sold again');

    id = await mk({ capacity: 3, status: 'scheduled', durationMinutes: 60, startsAt: new Date() }); // legacy: no seatsTaken field
    for (let i = 0; i < 2; i++) await Order.create({ userId: `u${i}`, isDelete: false, isPaid: true, sellerOrders: [{ items: [{ productId: id, status: 'pending' }] }] });
    assert.strictEqual((await claimLiveSeats(Product, Order, [line(id)])).length, 1);
    await assert.rejects(claimLiveSeats(Product, Order, [line(id)]), /full/);
    ok('legacy class (no counter) is reconciled from paid orders: no oversell');

    const open = await mk({ capacity: null, seatsTaken: 0, status: 'scheduled', durationMinutes: 60, startsAt: new Date() });
    res = await Promise.allSettled(Array.from({ length: 20 }, () => claimLiveSeats(Product, Order, [line(open)])));
    assert.ok(res.every((r) => r.status === 'fulfilled'));
    const gone = await mk({ capacity: 10, seatsTaken: 0, status: 'cancelled', durationMinutes: 60, startsAt: new Date() });
    await assert.rejects(claimLiveSeats(Product, Order, [line(gone)]), /cancelled/);
    ok('uncapped class is never full; cancelled class is never sold');

    // Two lines in one order: the second class is full, so the first line's seat must be given back.
    const a = await mk({ capacity: 5, seatsTaken: 0, status: 'scheduled', durationMinutes: 60, startsAt: new Date() });
    const b = await mk({ capacity: 1, seatsTaken: 1, status: 'scheduled', durationMinutes: 60, startsAt: new Date() });
    await assert.rejects(claimLiveSeats(Product, Order, [line(a), line(b)]), /full/);
    assert.strictEqual(await taken(a), 0);
    ok('a failed second line rolls back the first line');
    console.log(`\n${n} checks passed`);
  } finally {
    await conn.dropDatabase();
    await conn.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
})().catch((e) => { console.error('FAILED:', e && e.stack ? e.stack : e); process.exit(1); });
