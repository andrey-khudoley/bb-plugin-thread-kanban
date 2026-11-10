import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { settingsStore } from "./settings-server";

const value = z.string().min(1).max(512);
export const executionSelection = z.object({
  providerId: value.optional(), model: value.optional(),
  reasoningLevel: value.optional(), serviceTier: value.optional(),
});
export const launchOptions = z.object({
  selection: executionSelection,
  modelLabel: z.string(),
  efforts: z.array(z.object({ id: z.string(), label: z.string() })),
  speeds: z.array(z.object({ id: z.string(), label: z.string() })),
  warning: z.string().nullable(),
});
type Selection = z.infer<typeof executionSelection>;
type Environment = NonNullable<Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]["environment"]>;

// Resolve at launch time, on the same host that will execute the new thread.
export async function resolveLaunchSettings(bb: BbPluginApi, projectId: string, environment: Environment,
  explicit: Selection = {}, preview = false): Promise<z.infer<typeof launchOptions>> {
  const saved = (await settingsStore(bb).read()).preference;
  const sameProvider = !explicit.providerId || explicit.providerId === saved?.providerId;
  const sameModel = sameProvider && (!explicit.model || explicit.model === saved?.model);
  const selection: Selection = {
    ...(sameProvider ? saved : {}),
    ...(!sameModel ? { model: explicit.model, reasoningLevel: undefined, serviceTier: undefined } : {}),
    ...Object.fromEntries(Object.entries(explicit).filter(([, item]) => item !== undefined)),
  };
  if (!preview && !saved && !Object.values(explicit).some((item) => item !== undefined)) {
    return { selection: {}, modelLabel: "По настройкам BB", efforts: [], speeds: [], warning: null };
  }
  const route = environment.type === "reuse" ? { environmentId: environment.environmentId }
    : { projectId, hostId: environment.type === "host" ? environment.hostId
      : environment.type === "provider" && environment.machine?.type === "existing" ? environment.machine.hostId : undefined };
  const catalog = await bb.sdk.providers.models({ ...route, providerId: selection.providerId });
  if (catalog.modelLoadError) throw new Error(`Не удалось загрузить параметры модели: ${catalog.modelLoadError.detail ?? catalog.modelLoadError.code}`);
  const model = selection.model ? catalog.models.find(({ model }) => model === selection.model)
    : catalog.models.find(({ isDefault }) => isDefault) ?? catalog.models[0];
  if (!model) throw new Error(`Модель ${selection.model ?? "по умолчанию"} недоступна. Выбери модель в настройках канбана.`);
  const provider = catalog.providers.find(({ id, available }) => available && id === (selection.providerId ?? model.routeProviderId))
    ?? (!selection.providerId ? catalog.providers.find(({ available }) => available) : undefined);
  if (!provider) throw new Error("Выбранный агент недоступен в окружении запуска.");
  const efforts = model.supportedReasoningEfforts.map(({ reasoningEffort, label }) => ({ id: reasoningEffort, label: label ?? reasoningEffort }));
  const speeds = provider.capabilities.supportsServiceTier
    ? [{ id: "default", label: "Обычная" }, ...(provider.serviceTiers ?? []).filter(({ id }) => id !== "default" &&
      (!model.supportedServiceTiers || model.supportedServiceTiers.some((tier) => tier.id === id))).map(({ id, label }) => ({ id, label }))] : [];
  const warning = selection.reasoningLevel && !efforts.some(({ id }) => id === selection.reasoningLevel)
    ? `Модель ${model.displayName} не поддерживает усилие ${selection.reasoningLevel}. Выбери доступный уровень для запуска или измени настройки канбана.`
    : selection.serviceTier && !speeds.some(({ id }) => id === selection.serviceTier)
      ? `Модель ${model.displayName} не поддерживает скорость ${selection.serviceTier}. Выбери доступную скорость для запуска или измени настройки канбана.` : null;
  if (warning && !preview) throw new Error(warning);
  // Preserve native BB defaults when the user has no saved or explicit selection.
  if (saved || Object.values(explicit).some((item) => item !== undefined)) {
    selection.providerId = provider.id;
    selection.model = model.model;
  }
  return { selection, modelLabel: model.displayName, efforts, speeds, warning };
}
