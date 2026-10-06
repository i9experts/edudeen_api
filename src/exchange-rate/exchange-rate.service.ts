import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { AdminConfigService } from 'src/admin-config/admin-config.service';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { FxSnapshot, SUPPORTED_CURRENCIES, SupportedCurrency } from './schemas/exchange-rate.schema';

interface AuditMeta {
  adminId?: string;
  ip?: string;
  userAgent?: string;
}

/**
 * The single authoritative source for every PKR/USD (and later EUR/GBP/...)
 * conversion in the marketplace — see ExchangeRate schema's comment. USD is
 * the fixed pivot: every currency's rate is stored as "units of that
 * currency per 1 USD", so converting between any two supported currencies
 * always routes through USD (A → USD → B), which is what makes adding a
 * third currency later a config change, not a redesign.
 *
 * Deliberately reads the latest ExchangeRate row directly from Mongo on
 * every call rather than keeping an in-memory cache — at this call volume
 * (once per checkout creation, never per product-card render) the indexed
 * `{currency:1, effectiveFrom:-1}` lookup is cheap, and this fully avoids
 * the multi-instance cache-invalidation problem a TTL cache would
 * introduce (no cache = nothing that can ever be stale across instances).
 */
@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly adminConfigService: AdminConfigService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get model() {
    return this.databaseService.repositories.exchangeRateModel;
  }

  assertSupportedCurrency(currency: string): asserts currency is SupportedCurrency {
    if (!SUPPORTED_CURRENCIES.includes(currency as SupportedCurrency)) {
      throw new BadRequestException(
        `Unsupported currency "${currency}" — must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`,
      );
    }
  }

  /** The latest non-rejected rate for a currency, or null if none exists yet. */
  async getCurrentRate(currency: string) {
    return this.model
      .findOne({ currency, isRejected: false })
      .sort({ effectiveFrom: -1 })
      .lean();
  }

  async getAllCurrentRates(): Promise<Record<string, { ratePerUSD: number; effectiveFrom: Date; source: string } | null>> {
    const entries = await Promise.all(
      SUPPORTED_CURRENCIES.map(async (c) => [c, await this.getCurrentRate(c)] as const),
    );
    return Object.fromEntries(entries);
  }

  private async requireCurrentRate(currency: string) {
    if (currency === 'USD') {
      return { currency: 'USD', ratePerUSD: 1, effectiveFrom: new Date(), source: 'admin' as const, _id: null };
    }
    const rate = (await this.getCurrentRate(currency)) ?? (await this.bootstrapRate(currency));
    if (!rate) {
      throw new BadRequestException(
        `No exchange rate available for ${currency} — cannot convert or checkout in this currency yet`,
      );
    }

    // Beyond the stale-rate ceiling, silently proceeding would mean charging
    // a buyer/settling a seller off a rate that could be arbitrarily out of
    // date. `buildSnapshots` (checkout creation) is this method's only real
    // caller in the current codebase, so this effectively blocks new
    // cross-currency checkouts until an admin refreshes/overrides the rate —
    // exactly the "manual review" outcome the sane-band/abnormal-jump checks
    // above already use, rather than a silent indefinitely-stale conversion.
    const fxConfig = await this.adminConfigService.getFxConfig();
    const staleThresholdHours = fxConfig?.staleRateAlertThresholdHours ?? 48;
    const hoursOld = (Date.now() - new Date(rate.effectiveFrom).getTime()) / (1000 * 60 * 60);
    if (hoursOld > staleThresholdHours) {
      await this.activityLogService.log({
        storeId: 'platform',
        category: 'finance',
        action: 'fx_rate_too_stale_for_checkout',
        description: `Blocked a conversion/checkout needing ${currency} — its current rate is ${hoursOld.toFixed(1)}h old, past the ${staleThresholdHours}h ceiling`,
        actorId: 'system',
        actorRole: 'system',
        isSecurityAlert: true,
      });
      throw new BadRequestException(
        `${currency} pricing is temporarily unavailable while we refresh exchange rates — please try again shortly or choose a different currency.`,
      );
    }

    return rate;
  }

  /**
   * Converts `amount` from `fromCurrency` to `toCurrency` via the USD pivot.
   * Rounds ONLY the final result — never the intermediate USD value — so a
   * two-hop conversion (e.g. PKR → USD → EUR once EUR exists) never
   * compounds rounding error at the pivot step.
   */
  async convert(amount: number, fromCurrency: string, toCurrency: string): Promise<number> {
    if (fromCurrency === toCurrency) return amount;
    const fromRate = await this.requireCurrentRate(fromCurrency);
    const toRate = await this.requireCurrentRate(toCurrency);
    const amountInUSD = amount / fromRate.ratePerUSD; // no rounding here
    const converted = amountInUSD * toRate.ratePerUSD; // no rounding here
    return this.roundForCurrency(converted, toCurrency);
  }

  /** PKR (and USD, in this codebase's convention) have no meaningful sub-unit for consumer pricing — whole units. USD keeps cents. */
  roundForCurrency(amount: number, currency: string): number {
    if (currency === 'PKR') return Math.round(amount);
    return Math.round(amount * 100) / 100;
  }

  /**
   * Builds the immutable fxSnapshots array for a checkout: one entry per
   * distinct currency actually involved (every seller currency present in
   * the cart, plus the buyer's checkout currency). Copied verbatim onto
   * Order/PaymentTransaction at creation time and replayed — never
   * re-derived from today's rate — by refunds and settlement.
   *
   * When `currencies` collapses to a single distinct value (e.g. a PKR
   * buyer checking out PKR-priced items, physical-order shipping included —
   * see SHIPPING_ZONE_CURRENCY), nothing in this checkout ever actually
   * converts between two currencies: `convert`/`convertWithSnapshots` always
   * short-circuit a same-currency pair, so that one entry's rate is
   * mathematically never read back. Requiring it to be *fresh* in that case
   * would block an entirely single-currency checkout over a staleness gate
   * meant to guard real cross-currency conversions (see `ingestRate`'s
   * abnormal-jump comment, which frames this as blocking "cross-currency
   * checkouts") — so that one gate is skipped here, falling back to the
   * last-known rate however old (still required to exist at least once).
   */
  async buildSnapshots(currencies: string[]): Promise<FxSnapshot[]> {
    const unique = Array.from(new Set(currencies));
    const singleCurrency = unique.length === 1;
    const snapshots: FxSnapshot[] = [];
    for (const currency of unique) {
      const rate = singleCurrency
        ? await this.lastKnownRate(currency)
        : await this.requireCurrentRate(currency);
      snapshots.push({
        currency,
        ratePerUSD: rate.ratePerUSD,
        effectiveFrom: rate.effectiveFrom,
        source: rate.source,
        exchangeRateId: rate._id ? String(rate._id) : null,
      });
    }
    return snapshots;
  }

  /** Like `requireCurrentRate`, but never rejects for staleness — only when
   *  no rate has ever been ingested for `currency` at all. Only safe to use
   *  where the rate is guaranteed to never back a real cross-currency
   *  conversion (see `buildSnapshots`'s single-currency case above). */
  private async lastKnownRate(currency: string) {
    if (currency === 'USD') {
      return { currency: 'USD', ratePerUSD: 1, effectiveFrom: new Date(), source: 'admin' as const, _id: null };
    }
    const rate = (await this.getCurrentRate(currency)) ?? (await this.bootstrapRate(currency));
    if (!rate) {
      throw new BadRequestException(
        `No exchange rate available for ${currency} — cannot convert or checkout in this currency yet`,
      );
    }
    return rate;
  }

  /**
   * Converts `amount` using an ALREADY-SNAPSHOTTED set of rates (from an
   * existing Checkout/Order/PaymentTransaction's fxSnapshots) rather than
   * today's live rate — this is what refunds and settlement recomputation
   * must call, never `convert()` above.
   */
  convertWithSnapshots(
    amount: number,
    fromCurrency: string,
    toCurrency: string,
    snapshots: FxSnapshot[],
  ): number {
    if (fromCurrency === toCurrency) return amount;
    const findRate = (currency: string) => {
      if (currency === 'USD') return 1;
      const snap = snapshots.find((s) => s.currency === currency);
      if (!snap) {
        throw new BadRequestException(
          `No snapshotted rate for ${currency} found on this transaction — cannot recompute historically`,
        );
      }
      return snap.ratePerUSD;
    };
    const amountInUSD = amount / findRate(fromCurrency);
    const converted = amountInUSD * findRate(toCurrency);
    return this.roundForCurrency(converted, toCurrency);
  }

  /**
   * Ingests a newly-observed rate (from the daily cron, source:'provider',
   * or an admin override, source:'admin'). A rate outside the configured
   * sane band is rejected outright (never persisted as current). A rate
   * that's within the sane band but has jumped more than
   * abnormalJumpAlertPercent from the current rate is HELD (isRejected:
   * true, visible in history for audit, but never becomes "current") rather
   * than auto-promoted — once an order is created against a rate it's
   * immutable forever, so a bad automatic promotion can't be undone the way
   * a held one can. Admin overrides skip the abnormal-jump hold (that's
   * what an explicit admin action is for) but still go through the sane
   * band, to catch a fat-fingered typo.
   */
  async ingestRate(
    currency: string,
    ratePerUSD: number,
    source: 'provider' | 'admin',
    meta: AuditMeta = {},
  ) {
    this.assertSupportedCurrency(currency);
    const fxConfig = await this.adminConfigService.getFxConfig();

    if (currency !== 'USD') {
      const min = fxConfig?.sanityBandMinPKR ?? 150;
      const max = fxConfig?.sanityBandMaxPKR ?? 450;
      if (!(ratePerUSD >= min && ratePerUSD <= max) || !Number.isFinite(ratePerUSD) || ratePerUSD <= 0) {
        await this.activityLogService.log({
          storeId: 'platform',
          category: 'finance',
          action: 'fx_rate_rejected_sanity_band',
          description: `Rejected ${currency} rate ${ratePerUSD} — outside sane band [${min}, ${max}]`,
          actorId: meta.adminId ?? 'system',
          actorRole: meta.adminId ? 'admin' : 'system',
          isSecurityAlert: true,
        });
        await this.model.create({
          currency, ratePerUSD, effectiveFrom: new Date(), source,
          createdBy: meta.adminId ?? null, isRejected: true, rejectionReason: 'sanity_band',
        });
        throw new BadRequestException(
          `Rate ${ratePerUSD} for ${currency} is outside the configured sane band [${min}, ${max}] — rejected, not applied`,
        );
      }

      if (source === 'provider') {
        const current = await this.getCurrentRate(currency);
        if (current) {
          const jumpPercent = Math.abs(ratePerUSD - current.ratePerUSD) / current.ratePerUSD * 100;
          const threshold = fxConfig?.abnormalJumpAlertPercent ?? 8;
          if (jumpPercent > threshold) {
            await this.model.create({
              currency, ratePerUSD, effectiveFrom: new Date(), source,
              createdBy: null, isRejected: true, rejectionReason: 'abnormal_jump',
            });
            await this.activityLogService.log({
              storeId: 'platform',
              category: 'finance',
              action: 'fx_rate_held_abnormal_jump',
              description: `Held new ${currency} rate ${ratePerUSD} (${jumpPercent.toFixed(1)}% jump from current ${current.ratePerUSD}) for admin confirmation — not auto-applied`,
              actorId: 'system',
              actorRole: 'system',
              isSecurityAlert: true,
            });
            this.logger.warn(`FX rate for ${currency} held for admin review: ${jumpPercent.toFixed(1)}% jump`);
            return { applied: false, held: true };
          }
        }
      }
    }

    const row = await this.model.create({
      currency,
      ratePerUSD,
      effectiveFrom: new Date(),
      source,
      createdBy: meta.adminId ?? null,
      isRejected: false,
    });

    if (source === 'admin') {
      await this.activityLogService.log({
        storeId: 'platform',
        category: 'finance',
        action: 'fx_rate_admin_override',
        description: `Admin set ${currency} rate to ${ratePerUSD} per USD`,
        actorId: meta.adminId ?? 'admin',
        actorRole: 'admin',
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }

    return { applied: true, held: false, data: row };
  }

  /** History for the admin FX settings page — newest first, paginated. */
  async getHistory(currency: string | undefined, page: number, limit: number) {
    const filter: any = {};
    if (currency) filter.currency = currency;
    const [items, total] = await Promise.all([
      this.model.find(filter).sort({ effectiveFrom: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.model.countDocuments(filter),
    ]);
    return { items, total, page, limit };
  }

  private async fetchProviderRate(currency: string): Promise<number> {
    const res = await fetch(`https://api.frankfurter.app/latest?from=USD&to=${currency}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Provider returned HTTP ${res.status}`);
    const data = (await res.json()) as { rates?: Record<string, number> };
    const rate = data?.rates?.[currency];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Provider returned an invalid rate: ${JSON.stringify(data)}`);
    }
    return rate;
  }

  /** A currency with no rate at all (fresh database, before the daily cron has
   *  ever run) would block every checkout in it. Fetch the first rate on demand
   *  through the normal sanity-checked ingest; null if the provider is down, in
   *  which case the caller reports the missing rate as before. */
  private async bootstrapRate(currency: string) {
    try {
      await this.ingestRate(currency, await this.fetchProviderRate(currency), 'provider');
    } catch (err: any) {
      this.logger.warn(`On-demand FX fetch for ${currency} failed: ${err?.message}`);
      return null;
    }
    return this.getCurrentRate(currency);
  }
  /**
   * Called by SchedulerService's daily cron. Fetches each non-USD supported
   * currency's rate from a free, keyless FX API (Frankfurter — ECB-sourced)
   * and runs it through `ingestRate`'s sanity-band/abnormal-jump gate. A
   * per-currency failure never blocks the others, and never throws out of
   * this method — the caller (the cron job) must be able to complete the
   * tick and leave every currency on its last-known-good rate if the
   * provider is unreachable. NOTE: this sandboxed dev environment has no
   * outbound internet egress to verify this call actually succeeds against
   * a live provider — this must be verified in the real deployment
   * environment before relying on it in production.
   */
  async refreshFromProvider(): Promise<void> {
    for (const currency of SUPPORTED_CURRENCIES) {
      if (currency === 'USD') continue;
      try {
        await this.ingestRate(currency, await this.fetchProviderRate(currency), 'provider');
      } catch (err: any) {
        this.logger.warn(`FX provider refresh failed for ${currency}: ${err?.message} — keeping last-known-good rate`);
        await this.activityLogService.log({
          storeId: 'platform',
          category: 'finance',
          action: 'fx_provider_refresh_failed',
          description: `FX provider refresh failed for ${currency}: ${err?.message}`,
          actorId: 'system',
          actorRole: 'system',
          isSecurityAlert: true,
        });
      }
    }
  }

  /**
   * Guarantees `currency` is resolvable against `snapshots` — if it already
   * is (or it's 'USD', the pivot), returns them unchanged; otherwise fetches
   * today's current rate for it and returns an EXTENDED array with a new
   * snapshot entry appended. This only comes up when a currency need arises
   * mid-transaction that wasn't anticipated when the original checkout
   * snapshot was built (e.g. a buyer paying a USD-only checkout via the
   * PKR-only manual bank-transfer rail) — the caller is responsible for
   * persisting the returned array back onto whatever document it came from
   * so the addition itself becomes part of that record's immutable history.
   */
  async ensureCurrencyInSnapshots(snapshots: FxSnapshot[], currency: string): Promise<FxSnapshot[]> {
    if (currency === 'USD' || snapshots.some((s) => s.currency === currency)) {
      return snapshots;
    }
    const [newSnapshot] = await this.buildSnapshots([currency]);
    return [...snapshots, newSnapshot];
  }

  /** Used by the hourly staleness-check cron and the admin FX settings page. */
  async getStaleness() {
    const fxConfig = await this.adminConfigService.getFxConfig();
    const thresholdHours = fxConfig?.staleRateAlertThresholdHours ?? 48;
    const results: Record<string, { hoursOld: number; isStale: boolean } | null> = {};
    for (const currency of SUPPORTED_CURRENCIES) {
      if (currency === 'USD') { results[currency] = { hoursOld: 0, isStale: false }; continue; }
      const rate = await this.getCurrentRate(currency);
      if (!rate) { results[currency] = null; continue; }
      const hoursOld = (Date.now() - new Date(rate.effectiveFrom).getTime()) / (1000 * 60 * 60);
      results[currency] = { hoursOld, isStale: hoursOld > thresholdHours };
    }
    return results;
  }
}
