import { readFileSync } from 'fs';
import { join } from 'path';

// Guard: the maintenance 503 middleware must be registered AFTER enableCors, otherwise the
// browser hides the 503 JSON from the web app (no CORS headers).
describe('main.ts middleware order', () => {
  it('registers CORS before the maintenance middleware', () => {
    const src = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    const cors = src.indexOf('app.enableCors(');
    const maint = src.indexOf('maintenanceBlockFor(');
    expect(cors).toBeGreaterThan(-1);
    expect(maint).toBeGreaterThan(cors);
  });
});
