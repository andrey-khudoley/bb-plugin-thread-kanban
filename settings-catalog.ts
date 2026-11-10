import type { ComposerSelection, PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import type { Preference } from "./settings-contract";

type ModelCatalog = Awaited<ReturnType<PluginBrowserBbSdk["providers"]["models"]>>;
export type Model = ModelCatalog["models"][number];
type Provider = ModelCatalog["providers"][number];

export function reasoningFor(model: Model, preferred?: string) {
  const levels = model.supportedReasoningEfforts;
  if (levels.some(({ reasoningEffort }) => reasoningEffort === preferred)) return preferred;
  if (levels.some(({ reasoningEffort }) => reasoningEffort === model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }
  return levels[0]?.reasoningEffort;
}

export function resolveModel(catalog: readonly Model[], preferred?: string) {
  const match = catalog.find(({ model }) => model === preferred);
  return match ?? catalog.find(({ isDefault }) => isDefault) ?? catalog[0];
}

export function speedOptions(model: Model | undefined, provider: Provider | undefined) {
  if (!model || !provider?.capabilities.supportsServiceTier) return [];
  const tiers = (provider.serviceTiers ?? []).filter(({ id }) => id !== "default");
  const supportedTiers = model.supportedServiceTiers;
  if (!supportedTiers) return tiers;
  return tiers.flatMap((tier) => {
    const supported = supportedTiers.find(({ id }) => id === tier.id);
    return supported ? [{ id: tier.id, label: supported.label ?? tier.label }] : [];
  });
}

export function speedFor(options: readonly { id: string }[], preferred?: string) {
  if (preferred === undefined) return undefined;
  return options.some(({ id }) => id === preferred) ? preferred : "default";
}

export function preferenceFor(
  provider: Provider,
  model: Model,
  preferred: Pick<Preference, "reasoningLevel" | "serviceTier"> = {},
): Preference {
  const reasoningLevel = reasoningFor(model, preferred.reasoningLevel);
  const serviceTier = provider.capabilities.supportsServiceTier
    ? speedFor(speedOptions(model, provider), preferred.serviceTier)
    : undefined;
  return {
    providerId: provider.id,
    model: model.model,
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

export function catalogRoute({ projectId, environment }: ComposerSelection) {
  if (environment?.type === "reuse") return { environmentId: environment.environmentId };
  const hostId = environment?.type === "host" ? environment.hostId
    : environment?.type === "provider" && environment.machine?.type === "existing" ? environment.machine.hostId
    : undefined;
  return { projectId, ...(hostId ? { hostId } : {}) };
}

export async function resolvePreference(
  providers: PluginBrowserBbSdk["providers"],
  current: ComposerSelection,
  saved: Preference,
  signal: AbortSignal,
) {
  const route = catalogRoute(current);
  const preferred = await providers.models({ ...route, providerId: saved.providerId, signal });
  const provider = preferred.providers.find(({ id, available }) => id === saved.providerId && available);
  const model = resolveModel(preferred.models, saved.model);
  if (provider && model) {
    return preferenceFor(provider, model, model.model === saved.model ? saved : {
      serviceTier: saved.serviceTier === undefined ? undefined : "default",
    });
  }
  if (!current.providerId || current.providerId === saved.providerId) return null;
  const fallback = await providers.models({ ...route, providerId: current.providerId, signal });
  const fallbackProvider = fallback.providers.find(({ id, available }) => id === current.providerId && available);
  const fallbackModel = resolveModel(fallback.models);
  return fallbackProvider && fallbackModel ? preferenceFor(fallbackProvider, fallbackModel, {
    serviceTier: saved.serviceTier === undefined ? undefined : "default",
  }) : null;
}
