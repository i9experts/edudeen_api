/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { encryptSeoCredential, decryptSeoCredential } from 'src/common/seo-token-encryption.util';
import { GoogleSearchConsoleProvider } from '../providers/google-search-console.provider';
import { GoogleAnalyticsProvider } from '../providers/google-analytics.provider';
import { GoogleMerchantCenterProvider } from '../providers/google-merchant-center.provider';
import { BingWebmasterProvider } from '../providers/bing-webmaster.provider';
import { ISeoSearchProvider, SeoCoverageResult, SeoPerformanceRow } from '../providers/seo-search-provider.interface';
import { SeoIntegrationProvider } from '../schemas/seo-integration.schema';

export interface SeoIntegrationScope {
  scope: 'platform' | 'store';
  storeId: string | null;
  sellerId?: string | null;
}

/**
 * Thin orchestrator over the 4 `ISeoSearchProvider` adapters — owns the
 * concerns every provider shares exactly once: token encryption at rest,
 * the `status` state machine, and activity logging. See architecture plan
 * Refinement #2 and #8.
 */
@Injectable()
export class SeoIntegrationsService {
  private readonly providers: Record<SeoIntegrationProvider, ISeoSearchProvider>;

  constructor(
    private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService,
    gsc: GoogleSearchConsoleProvider,
    ga4: GoogleAnalyticsProvider,
    merchantCenter: GoogleMerchantCenterProvider,
    bing: BingWebmasterProvider,
  ) {
    this.providers = { gsc, ga4, merchant_center: merchantCenter, bing };
  }

  private get model() {
    return this.db.repositories.seoIntegrationModel;
  }

  private getProvider(provider: SeoIntegrationProvider): ISeoSearchProvider {
    const impl = this.providers[provider];
    if (!impl) throw new BadRequestException(`Unknown SEO integration provider "${provider}".`);
    return impl;
  }

  getAuthorizationUrl(provider: SeoIntegrationProvider, redirectUri: string, state: string): string {
    return this.getProvider(provider).getAuthorizationUrl(redirectUri, state);
  }

  async list(scope: SeoIntegrationScope) {
    return this.model.find({ scope: scope.scope, storeId: scope.storeId }).select('-accessTokenEncrypted -refreshTokenEncrypted').lean();
  }

  async connect(
    scope: SeoIntegrationScope,
    provider: SeoIntegrationProvider,
    authCode: string,
    redirectUri: string,
    siteIdentifier: string,
    actor: { id: string; name?: string; role?: string },
  ) {
    const impl = this.getProvider(provider);
    const tokens = await impl.exchangeCodeForTokens(authCode, redirectUri);

    const owns = await impl.verifyOwnership(tokens.accessToken, siteIdentifier);
    if (!owns) {
      throw new BadRequestException(`This account does not have verified access to "${siteIdentifier}" on ${provider}.`);
    }

    const integration = await this.model.findOneAndUpdate(
      { scope: scope.scope, storeId: scope.storeId, provider },
      {
        $set: {
          scope: scope.scope,
          storeId: scope.storeId,
          sellerId: scope.sellerId ?? null,
          provider,
          accessTokenEncrypted: encryptSeoCredential(tokens.accessToken),
          refreshTokenEncrypted: tokens.refreshToken ? encryptSeoCredential(tokens.refreshToken) : null,
          accessTokenExpiresAt: tokens.expiresAt,
          config: { siteIdentifier },
          status: 'connected',
          lastError: null,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );

    await this.activityLog.log({
      storeId: scope.storeId ?? undefined,
      category: 'seo',
      action: 'seo_integration_connected',
      description: `${provider} connected for ${siteIdentifier}`,
      actorId: actor.id, actorName: actor.name ?? null, actorRole: actor.role ?? null,
      targetId: integration._id.toString(), targetType: 'seo_integration',
    });

    return { success: true, status: integration.status };
  }

  async disconnect(scope: SeoIntegrationScope, provider: SeoIntegrationProvider, actor: { id: string; name?: string; role?: string }) {
    const integration = await this.model.findOne({ scope: scope.scope, storeId: scope.storeId, provider });
    if (!integration) throw new NotFoundException('Integration not found.');

    integration.status = 'disconnected';
    integration.accessTokenEncrypted = null;
    integration.refreshTokenEncrypted = null;
    await integration.save();

    await this.activityLog.log({
      storeId: scope.storeId ?? undefined,
      category: 'seo',
      action: 'seo_integration_disconnected',
      actorId: actor.id, actorName: actor.name ?? null, actorRole: actor.role ?? null,
      targetId: integration._id.toString(), targetType: 'seo_integration',
    });

    return { success: true };
  }

  /**
   * Pulls a fresh access token (refreshing if needed), calls the provider's
   * coverage+performance methods, and updates the integration's own
   * status/lastSyncedAt. Does NOT persist the results into
   * SeoIndexSnapshot/SeoAnalyticsSnapshot — that's `SeoMonitoringService`'s
   * job (Phase 5), which calls this and stores the returned data.
   */
  async sync(
    scope: SeoIntegrationScope,
    provider: SeoIntegrationProvider,
    from: Date,
    to: Date,
  ): Promise<{ coverage: SeoCoverageResult; performance: SeoPerformanceRow[] }> {
    const integration = await this.model.findOne({ scope: scope.scope, storeId: scope.storeId, provider });
    if (!integration || integration.status === 'disconnected') throw new NotFoundException('Integration not connected.');

    const impl = this.getProvider(provider);
    const siteIdentifier = integration.config?.siteIdentifier;

    try {
      integration.status = 'syncing';
      await integration.save();

      const accessToken = await this.getValidAccessToken(integration, impl);
      const [coverage, performance] = await Promise.all([
        impl.syncCoverage(accessToken, siteIdentifier),
        impl.syncPerformance(accessToken, siteIdentifier, from, to),
      ]);

      integration.status = 'connected';
      integration.lastSyncedAt = new Date();
      integration.lastError = null;
      await integration.save();

      return { coverage, performance };
    } catch (err: any) {
      const isAuthError = /invalid_grant|unauthorized|401|403/i.test(err?.message ?? '');
      integration.status = isAuthError ? 'needs_reauth' : 'error';
      integration.lastError = err?.message ?? 'Unknown sync error';
      await integration.save();
      throw err;
    }
  }

  private async getValidAccessToken(integration: any, impl: ISeoSearchProvider): Promise<string> {
    const isExpired = !integration.accessTokenExpiresAt || integration.accessTokenExpiresAt.getTime() <= Date.now() + 60_000;
    if (!isExpired && integration.accessTokenEncrypted) {
      return decryptSeoCredential(integration.accessTokenEncrypted);
    }
    if (!integration.refreshTokenEncrypted) {
      throw new Error('No refresh token on file — reconnection required (needs_reauth).');
    }
    const refreshToken = decryptSeoCredential(integration.refreshTokenEncrypted);
    const refreshed = await impl.refreshAccessToken(refreshToken);
    integration.accessTokenEncrypted = encryptSeoCredential(refreshed.accessToken);
    integration.accessTokenExpiresAt = refreshed.expiresAt;
    await integration.save();
    return refreshed.accessToken;
  }
}
