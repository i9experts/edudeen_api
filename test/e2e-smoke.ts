/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- script drives untyped JSON over HTTP */
/**
 * End-to-end smoke test for a RUNNING Edudeen API. It drives the real HTTP surface the QA program hardened and
 * prints PASS/FAIL per check; the exit code is non-zero if any check fails.
 *
 *   # 1. a throwaway database + the seeded QA accounts (src/scripts/seed-test-accounts.ts), then start the API
 *   # 2. run:
 *   SMOKE_BASE_URL=http://localhost:3002 \
 *   SMOKE_ADMIN_PASSWORD=... SMOKE_SELLER_PASSWORD=... SMOKE_BUYER_PASSWORD=... \
 *   npx ts-node test/e2e-smoke.ts
 *
 * Safety: it WRITES data (a category, an announcement, an address, a profile rename), so it refuses to run against
 * anything but localhost unless SMOKE_ALLOW_REMOTE=true. Point it at a disposable database, never production.
 * Needs Node 18+ (global fetch). No extra dependencies.
 */

const BASE = (process.env.SMOKE_BASE_URL ?? 'http://localhost:3002').replace(
  /\/$/,
  '',
);
const host = new URL(BASE).hostname;
if (
  !['localhost', '127.0.0.1', '::1'].includes(host) &&
  process.env.SMOKE_ALLOW_REMOTE !== 'true'
) {
  console.error(
    `Refusing to run against ${BASE}: this script writes data. Set SMOKE_ALLOW_REMOTE=true only for a disposable environment.`,
  );
  process.exit(2);
}

const ACCOUNTS = {
  admin: {
    email: process.env.SMOKE_ADMIN_EMAIL ?? 'admin@edudeen.test',
    password: process.env.SMOKE_ADMIN_PASSWORD ?? '',
    role: 'admin',
  },
  seller: {
    email: process.env.SMOKE_SELLER_EMAIL ?? 'seller@edudeen.test',
    password: process.env.SMOKE_SELLER_PASSWORD ?? '',
    role: 'seller',
  },
  buyer: {
    email: process.env.SMOKE_BUYER_EMAIL ?? 'buyer@edudeen.test',
    password: process.env.SMOKE_BUYER_PASSWORD ?? '',
    role: 'user',
  },
} as const;
for (const [k, v] of Object.entries(ACCOUNTS)) {
  if (!v.password) {
    console.error(`Missing SMOKE_${k.toUpperCase()}_PASSWORD`);
    process.exit(2);
  }
}

type Json = any;
interface Res {
  status: number;
  body: Json;
}

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  -> ${detail}` : ''}`,
  );
};

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: Json = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body };
}

const login = async (a: { email: string; password: string; role: string }) => {
  const r = await call('POST', '/api/auth/login', { body: a });
  const t = r.body?.data?.token;
  return {
    status: r.status,
    access: t?.accessToken as string | undefined,
    refresh: t?.refreshToken as string | undefined,
  };
};

async function main() {
  // ── liveness ────────────────────────────────────────────────────────────
  const live = await call('GET', '/health/live');
  check(
    'health/live responds 200',
    live.status === 200,
    `status ${live.status}`,
  );

  // ── auth ────────────────────────────────────────────────────────────────
  const [admin, seller, buyer] = await Promise.all([
    login(ACCOUNTS.admin),
    login(ACCOUNTS.seller),
    login(ACCOUNTS.buyer),
  ]);
  check(
    'admin, seller and buyer can log in',
    !!(admin.access && seller.access && buyer.access),
    `${admin.status}/${seller.status}/${buyer.status}`,
  );
  if (!admin.access || !seller.access || !buyer.access)
    throw new Error('cannot continue without all three sessions');

  const bad = await login({
    ...ACCOUNTS.buyer,
    password: 'definitely-wrong-password',
  });
  check(
    'wrong password is rejected (401)',
    bad.status === 401,
    `status ${bad.status}`,
  );

  if (admin.refresh) {
    const viaRefresh = await call('GET', '/api/admin/users/stats', {
      token: admin.refresh,
    });
    check(
      'a refresh token is NOT accepted as an access token',
      viaRefresh.status === 401,
      `status ${viaRefresh.status}`,
    );
  }

  // ── NoSQL operator injection (Phase 7) ──────────────────────────────────
  for (const [path, body] of [
    [
      '/api/auth/verifyOtp',
      { email: { $ne: null }, role: 'user', otp: '000000' },
    ],
    ['/api/auth/resend-otp', { email: { $ne: null }, role: 'user' }],
    ['/api/auth/forgot-password', { email: { $ne: null }, role: 'user' }],
    [
      '/api/auth/reset-password',
      {
        email: { $ne: null },
        role: 'user',
        otp: '000000',
        newPassword: 'longenough1',
      },
    ],
    [
      '/api/auth/login',
      { email: { $gt: '' }, password: { $gt: '' }, role: 'user' },
    ],
  ] as const) {
    const r = await call('POST', path, { body });
    check(
      `operator injection rejected: POST ${path}`,
      r.status === 400 || r.status === 401,
      `status ${r.status}`,
    );
  }

  // ── role guards ─────────────────────────────────────────────────────────
  check(
    'admin API without a token → 401',
    (await call('GET', '/api/admin/users')).status === 401,
  );
  check(
    'admin API with a buyer token → 403',
    (await call('GET', '/api/admin/users', { token: buyer.access })).status ===
      403,
  );
  check(
    'admin API with a seller token → 403',
    (await call('GET', '/api/admin/users', { token: seller.access })).status ===
      403,
  );
  check(
    'buyer cannot create a category → 403',
    (
      await call('POST', '/api/categories/add-category', {
        token: buyer.access,
        body: { name: 'Nope' },
      })
    ).status === 403,
  );

  // ── mass assignment / profile ───────────────────────────────────────────
  const rename = await call('PATCH', '/api/auth/edit-profile', {
    token: buyer.access,
    body: { name: 'Smoke Buyer', role: 'admin', isVerified: false },
  });
  check(
    'edit-profile cannot change the role',
    rename.status === 200 && rename.body?.data?.role === 'user',
    `status ${rename.status}, role ${rename.body?.data?.role}`,
  );

  // ── address allowlist (Phase 7) ─────────────────────────────────────────
  const addr = await call('POST', '/api/address/add-address', {
    token: buyer.access,
    body: {
      label: 'Home',
      recipientName: 'Smoke',
      phoneNumber: '1',
      addressLine1: 'x',
      state: 's',
      city: 'Karachi',
      zipCode: '1',
      country: 'PK',
    },
  });
  const addressId: string | undefined = addr.body?.data?._id;
  check(
    'buyer can add an address',
    addr.status === 201 && !!addressId,
    `status ${addr.status}`,
  );
  if (addressId) {
    const upd = await call('POST', '/api/address/update-address', {
      token: buyer.access,
      body: {
        addressId,
        city: 'Lahore',
        userId: '000000000000000000000001',
        isDelete: true,
      },
    });
    check(
      'update-address changes the city but not userId / isDelete',
      upd.body?.data?.city === 'Lahore' &&
        upd.body?.data?.userId !== '000000000000000000000001' &&
        upd.body?.data?.isDelete === false,
    );
    const objCity = await call('POST', '/api/address/update-address', {
      token: buyer.access,
      body: { addressId, city: { x: 1 } },
    });
    check(
      'update-address rejects a non-string field',
      typeof objCity.body?.message === 'string' &&
        /string/.test(objCity.body.message),
      JSON.stringify(objCity.body).slice(0, 120),
    );
  }

  // ── cart / search id guards ─────────────────────────────────────────────
  check(
    'clear-cart with a junk storeId → 400',
    (
      await call('POST', '/api/cart/clear-cart', {
        token: buyer.access,
        body: { storeId: 'nope' },
      })
    ).status === 400,
  );
  check(
    'recently-viewed with a junk productId → 400',
    (
      await call('POST', '/api/search/recently-viewed', {
        token: buyer.access,
        body: { productId: 'nope' },
      })
    ).status === 400,
  );

  // ── pagination clamp ────────────────────────────────────────────────────
  const orders = await call(
    'GET',
    '/api/orders/my-orders?limit=99999&page=-4',
    { token: buyer.access },
  );
  check(
    'buyer orders list survives limit=99999&page=-4',
    orders.status === 200,
    `status ${orders.status}`,
  );

  // ── admin: lists, details, validation ───────────────────────────────────
  check(
    'admin users list rejects limit=100000 → 400',
    (
      await call('GET', '/api/admin/users?limit=100000', {
        token: admin.access,
      })
    ).status === 400,
  );
  check(
    'admin users list handles a regex-bomb search → 200',
    (
      await call('GET', '/api/admin/users?search=(a%2B)%2B%24', {
        token: admin.access,
      })
    ).status === 200,
  );
  check(
    'admin route with a malformed id → 400',
    (await call('GET', '/api/admin/users/buyer/nope', { token: admin.access }))
      .status === 400,
  );

  const list = await call('GET', '/api/admin/users?role=buyer&limit=1', {
    token: admin.access,
  });
  const buyerId: string | undefined = list.body?.data?.items?.[0]?.id;
  if (buyerId) {
    const detail = await call('GET', `/api/admin/users/buyer/${buyerId}`, {
      token: admin.access,
    });
    const d = detail.body?.data ?? {};
    check(
      'admin user detail has no password / otp / fcmToken / tokenVersion',
      detail.status === 200 &&
        !['password', 'otp', 'fcmToken', 'tokenVersion'].some((k) => k in d),
    );
    check(
      'unsuspending an active buyer → 409',
      (
        await call('PATCH', `/api/admin/users/buyer/${buyerId}/unsuspend`, {
          token: admin.access,
        })
      ).status === 409,
    );
  } else {
    check(
      'admin user detail has no password / otp / fcmToken / tokenVersion',
      false,
      'no buyer found in the list',
    );
  }

  // ── admin config cross-field rule ───────────────────────────────────────
  const lowRate = await call(
    'PUT',
    '/api/admin/platform-config/manual-payment',
    { token: admin.access, body: { usdToPkrRate: 27.8 } },
  );
  check(
    'manual-payment rate outside the FX sanity band → 400',
    lowRate.status === 400,
    `status ${lowRate.status}`,
  );

  // ── admin → public flow: category + announcement ────────────────────────
  const catName = `Smoke ${Date.now()}`;
  const cat = await call('POST', '/api/categories/add-category', {
    token: admin.access,
    body: { name: catName },
  });
  check(
    'admin can create a category',
    cat.status === 201,
    `status ${cat.status}`,
  );

  const ann = await call('POST', '/api/admin/announcements', {
    token: admin.access,
    body: {
      title: `Smoke ${Date.now()}`,
      message: 'smoke test announcement',
      audience: 'buyers',
      status: 'published',
    },
  });
  check(
    'admin can publish an announcement',
    ann.status === 201,
    `status ${ann.status}`,
  );
  const pub = await call('GET', '/api/announcements/active?audience=buyers');
  const items: Json[] = pub.body?.data ?? [];
  check(
    'public announcements are visible without a token and do not expose createdBy',
    pub.status === 200 &&
      items.length > 0 &&
      items.every((i) => !('createdBy' in i)),
    `status ${pub.status}, items ${items.length}`,
  );
  const annId: string | undefined = ann.body?.data?._id;
  if (annId)
    await call('DELETE', `/api/admin/announcements/${annId}`, {
      token: admin.access,
    }); // tidy up

  // ── done ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed`,
  );
  if (failed.length) {
    console.log(
      'Failed:\n' +
        failed
          .map((f) => ` - ${f.name}${f.detail ? ` (${f.detail})` : ''}`)
          .join('\n'),
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(
    'Smoke test aborted:',
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
