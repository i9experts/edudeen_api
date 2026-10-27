// ISO-3166 alpha-2 country -> ISO-4217 currency, used ONLY to pick a buyer's DISPLAY currency.
// Charging stays USD/PKR (SUPPORTED_CURRENCIES); nothing here touches payments.

const COUNTRY_CURRENCY: Record<string, string> = {
  PK: 'PKR', US: 'USD', GB: 'GBP', AE: 'AED', SA: 'SAR', IN: 'INR', BD: 'BDT', LK: 'LKR', NP: 'NPR', AF: 'AFN',
  CA: 'CAD', AU: 'AUD', NZ: 'NZD', SG: 'SGD', MY: 'MYR', ID: 'IDR', TH: 'THB', PH: 'PHP', VN: 'VND', CN: 'CNY',
  JP: 'JPY', KR: 'KRW', HK: 'HKD', TW: 'TWD', TR: 'TRY', EG: 'EGP', QA: 'QAR', KW: 'KWD', BH: 'BHD', OM: 'OMR',
  JO: 'JOD', LB: 'LBP', IQ: 'IQD', IR: 'IRR', IL: 'ILS', MA: 'MAD', DZ: 'DZD', TN: 'TND', LY: 'LYD',
  NG: 'NGN', GH: 'GHS', KE: 'KES', ZA: 'ZAR', ET: 'ETB', TZ: 'TZS', UG: 'UGX', RU: 'RUB', UA: 'UAH', KZ: 'KZT',
  UZ: 'UZS', AZ: 'AZN', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON',
  BG: 'BGN', MX: 'MXN', BR: 'BRL', AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN',
  // Eurozone
  DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', IE: 'EUR', PT: 'EUR', FI: 'EUR',
  GR: 'EUR', LU: 'EUR', SK: 'EUR', SI: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', MT: 'EUR', CY: 'EUR', HR: 'EUR',
};

const ZERO_DECIMAL = new Set(['PKR', 'JPY', 'KRW', 'VND', 'IDR', 'CLP', 'UGX', 'IQD', 'IRR', 'LBP']);

export function normalizeCountry(code?: string | null): string | null {
  const c = (code ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null;
}

/** Display currency for a country, or null when unknown. */
export function currencyForCountry(country?: string | null): string | null {
  const c = normalizeCountry(country);
  return c ? COUNTRY_CURRENCY[c] ?? null : null;
}

/** True for USD, PKR and every currency we can show as a local display currency. */
export function isDisplayCurrency(code?: string | null): boolean {
  const c = (code ?? '').toUpperCase();
  return c === 'USD' || c === 'PKR' || Object.values(COUNTRY_CURRENCY).includes(c);
}

export function displayCurrencyDecimals(code: string): number {
  return ZERO_DECIMAL.has(code.toUpperCase()) ? 0 : 2;
}

/** Country from CDN/proxy headers (Cloudflare, Vercel, CloudFront), else null. */
export function countryFromHeaders(headers: Record<string, unknown> | undefined): string | null {
  if (!headers) return null;
  for (const h of ['cf-ipcountry', 'x-vercel-ip-country', 'cloudfront-viewer-country']) {
    const v = headers[h];
    const c = normalizeCountry(Array.isArray(v) ? String(v[0]) : (v as string | undefined));
    if (c) return c;
  }
  return null;
}
