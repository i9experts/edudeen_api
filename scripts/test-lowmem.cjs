// Runs jest with low memory. Adds VC++ runtime DLLs (msvcp140 etc., needed by jest's native
// unrs-resolver) to PATH on Windows by borrowing them from the installed Edge, if not on the system.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const env = { ...process.env };
if (process.platform === 'win32') {
  const base = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application';
  try {
    const v = fs.readdirSync(base).filter((n) => /^\d/.test(n)).sort().pop();
    if (v && fs.existsSync(path.join(base, v, 'msvcp140.dll'))) env.PATH = path.join(base, v) + ';' + env.PATH;
  } catch {}
}
env.NODE_OPTIONS = '--max-old-space-size=' + (process.env.LOWMEM_HEAP || '3072');
const jest = path.join(__dirname, '..', 'node_modules', 'jest', 'bin', 'jest.js');
const r = spawnSync(process.execPath, [jest, '--config', 'jest.config.cjs', '--runInBand', ...process.argv.slice(2)], { stdio: 'inherit', env, cwd: path.join(__dirname, '..') });
process.exit(r.status ?? 1);

