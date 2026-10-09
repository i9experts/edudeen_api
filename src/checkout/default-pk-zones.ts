/** Starter delivery zones for Pakistan (PKR). Applied only through the admin "Add default PK zones" action. */
export interface DefaultZone {
  province: string | null;
  city: string | null;
  shippingPrice: number;
  estimatedDeliveryTime: string;
}

export const DEFAULT_PK_ZONES: DefaultZone[] = [
  { province: 'Sindh', city: 'Karachi', shippingPrice: 200, estimatedDeliveryTime: '1-3 days' },
  { province: 'Punjab', city: 'Lahore', shippingPrice: 250, estimatedDeliveryTime: '2-3 days' },
  { province: 'Islamabad Capital Territory', city: 'Islamabad', shippingPrice: 250, estimatedDeliveryTime: '2-3 days' },
  { province: 'Punjab', city: 'Rawalpindi', shippingPrice: 250, estimatedDeliveryTime: '2-3 days' },
  { province: 'Punjab', city: 'Faisalabad', shippingPrice: 300, estimatedDeliveryTime: '2-4 days' },
  { province: 'Punjab', city: 'Multan', shippingPrice: 300, estimatedDeliveryTime: '2-4 days' },
  { province: 'Khyber Pakhtunkhwa', city: 'Peshawar', shippingPrice: 300, estimatedDeliveryTime: '3-4 days' },
  { province: 'Balochistan', city: 'Quetta', shippingPrice: 400, estimatedDeliveryTime: '4-6 days' },
  { province: 'Punjab', city: null, shippingPrice: 300, estimatedDeliveryTime: '3-5 days' },
  { province: 'Sindh', city: null, shippingPrice: 300, estimatedDeliveryTime: '3-5 days' },
  { province: 'Khyber Pakhtunkhwa', city: null, shippingPrice: 350, estimatedDeliveryTime: '3-6 days' },
  { province: 'Balochistan', city: null, shippingPrice: 450, estimatedDeliveryTime: '5-8 days' },
  { province: null, city: null, shippingPrice: 400, estimatedDeliveryTime: '4-7 days' }, // rest of Pakistan
];

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
export const zoneKey = (z: { country?: string | null; province?: string | null; city?: string | null }) =>
  `${norm(z.country)}|${norm(z.province)}|${norm(z.city)}`;

/** Defaults not already present (case-insensitive on country/province/city); existing zones are never touched. */
export function missingDefaultZones(existing: Array<{ country?: string | null; province?: string | null; city?: string | null }>): DefaultZone[] {
  const have = new Set(existing.map((z) => zoneKey({ ...z, country: z.country || 'Pakistan' })));
  return DEFAULT_PK_ZONES.filter((z) => !have.has(zoneKey({ country: 'Pakistan', province: z.province, city: z.city })));
}
