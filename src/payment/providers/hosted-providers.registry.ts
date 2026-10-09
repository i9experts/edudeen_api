import { EasypaisaProvider } from './easypaisa.provider';
import { JazzCashProvider } from './jazzcash.provider';
import type { EnvLike, HostedPaymentProvider, HostedProviderId, HttpPost } from './payment-provider.types';

/** Every hosted provider (configured or not), built from the given env. */
export function buildHostedProviders(env: EnvLike = process.env, httpPost?: HttpPost): HostedPaymentProvider[] {
  return [new JazzCashProvider(env), new EasypaisaProvider(env, httpPost)];
}

export function getHostedProvider(id: string, env: EnvLike = process.env, httpPost?: HttpPost): HostedPaymentProvider | null {
  return buildHostedProviders(env, httpPost).find((p) => p.id === (id as HostedProviderId)) ?? null;
}

/** Ids of providers that are configured AND support the currency: used by the checkout to decide what to offer. */
export function configuredHostedProviderIds(currency: string, env: EnvLike = process.env): HostedProviderId[] {
  return buildHostedProviders(env).filter((p) => p.isConfigured() && p.supportsCurrency(currency)).map((p) => p.id);
}
