// Wraps mongodump using MONGO_URI. Usage: npm run backup:db [-- <outDir>]
// Requires MongoDB Database Tools (mongodump) on PATH. Output: <outDir>/edudeen-<timestamp>.gz (default ./backups).
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const uri = process.env.MONGO_URI;
if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
const outDir = process.argv[2] || 'backups';
mkdirSync(outDir, { recursive: true });
const file = join(outDir, 'edudeen-' + new Date().toISOString().replace(/[:.]/g, '-') + '.gz');
const r = spawnSync('mongodump', ['--uri=' + uri, '--archive=' + file, '--gzip'], { stdio: 'inherit' });
if (r.error) { console.error('Could not run mongodump:', r.error.message); process.exit(1); }
if (r.status === 0) console.log('Backup written to ' + file);
process.exit(r.status ?? 1);
