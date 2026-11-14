import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  definePluginApp, experimental_useRpcQuery, useComposer, useRealtime, useRpc, useSdk,
  type ComposerSelection,
} from "@get-bb/plugin-sdk/app";
import { catalogRoute, preferenceFor, reasoningFor, resolveModel, resolvePreference, speedFor, speedOptions } from "./settings-catalog";
import { changed, contract, type Preference } from "./settings-contract";
import { WindowPlacementSettings } from "./settings-window";
import "./settings.css";

function sameExecution(left: ComposerSelection, right: ComposerSelection | null) {
  return left.providerId === right?.providerId && left.model === right?.model &&
    left.reasoningLevel === right?.reasoningLevel && left.serviceTier === right?.serviceTier;
}

function useChatDefaults() {
  const query = experimental_useRpcQuery({ contract, method: "read", input: null });
  useRealtime(changed, () => void query.refetch());
  return query;
}

function SettingsForm({ initial, current, onCancel, onSaved }: {
  initial: Preference | null;
  current: ComposerSelection;
  onCancel: () => void;
  onSaved?: (value: Preference | null) => Promise<void>;
}) {
  const sdk = useSdk();
  const rpc = useRpc<typeof contract>();
  const [providerId, setProvider] = useState(initial?.providerId ?? current.providerId ?? "");
  const [modelId, setModel] = useState(initial?.model ?? current.model);
  const [effort, setEffort] = useState(initial ? initial.reasoningLevel : current.reasoningLevel);
  const [speed, setSpeed] = useState(initial ? initial.serviceTier : current.serviceTier);
  const [automatic, setAutomatic] = useState(!initial && !current.model);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof sdk.providers.models>>>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const abort = new AbortController();
    const route = catalogRoute(current);
    const load = async () => {
      const result = await sdk.providers.models({ ...route, providerId: providerId || undefined, signal: abort.signal });
      const available = result.providers.filter((provider) => provider.available);
      const provider = available.find(({ id }) => id === providerId) ??
        available.find(({ id }) => id === current.providerId) ?? available[0];
      if (abort.signal.aborted) return;
      if (provider && provider.id !== providerId) {
        setProvider(provider.id);
        setModel(undefined);
        setEffort(undefined);
        setSpeed((value) => value === undefined ? undefined : "default");
        return;
      }
      setCatalog(result);
      setLoading(false);
    };
    void load().catch(() => {
      if (abort.signal.aborted) return;
      setError("Не удалось загрузить список моделей.");
      setLoading(false);
    });
    return () => abort.abort();
  }, [current, providerId, sdk]);

  const model = resolveModel(catalog?.models ?? [], modelId);
  const levels = model?.supportedReasoningEfforts ?? [];
  const selectedEffort = model ? reasoningFor(model, model.model === modelId ? effort : undefined) : undefined;
  const providers = catalog?.providers.filter(({ available }) => available) ?? [];
  const provider = providers.find(({ id }) => id === providerId);
  const speeds = speedOptions(model, provider);
  const selectedSpeed = speedFor(speeds, model?.model === modelId || speed === undefined ? speed : "default");
  const speedDisabled = automatic || loading || !speeds.length;
  const canSave = automatic || (!loading && Boolean(model && provider));

  return (
    <form className="chat-defaults-form" onChange={() => setSaved(false)} onSubmit={async (event) => {
      event.preventDefault();
      if (saving || !canSave) return;
      const value = automatic || !model || !provider ? null : preferenceFor(provider, model, {
        reasoningLevel: selectedEffort,
        serviceTier: selectedSpeed,
      });
      setSaving(true);
      setError("");
      try {
        await rpc.call("save", value);
      } catch {
        setError("Не удалось сохранить настройки.");
        setSaving(false);
        return;
      }
      if (onSaved) await onSaved(value);
      setSaving(false);
      setSaved(true);
    }}>
      <fieldset disabled={saving}>
        <label>
          Модель по умолчанию
          {providers.length > 1 && (
            <select aria-label="Провайдер модели" value={providerId} onChange={(event) => {
              setLoading(true);
              setError("");
              setAutomatic(false);
              setModel(undefined);
              setEffort(undefined);
              setSpeed(undefined);
              setProvider(event.target.value);
            }}>
              {providers.map(({ id, displayName }) => <option key={id} value={id}>{displayName}</option>)}
            </select>
          )}
          <select aria-label="Модель по умолчанию" disabled={loading} value={automatic ? "" : model?.model ?? "unavailable"}
            onChange={(event) => {
              setAutomatic(event.target.value === "");
              setEffort(selectedEffort);
              setSpeed(selectedSpeed);
              setModel(event.target.value);
            }}>
            <option value="">По настройкам BB</option>
            {!model && <option disabled value="unavailable">{loading ? "Загрузка…" : "Нет доступных моделей"}</option>}
            {catalog?.models.map((item) => <option key={item.id} value={item.model}>{item.displayName}</option>)}
          </select>
        </label>
        <label>
          Скорость по умолчанию
          <select disabled={speedDisabled} value={speedDisabled ? "" : selectedSpeed ?? ""}
            onChange={(event) => setSpeed(event.target.value || undefined)}>
            <option value="">{automatic ? "По настройкам BB" : loading ? "Загрузка…" :
              speeds.length ? "По настройкам BB" : "Недоступна для этой модели"}</option>
            {speeds.length > 0 && <option value="default">Обычная</option>}
            {speeds.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label>
          Уровень усилия по умолчанию
          <select disabled={automatic || loading || !levels.length} value={automatic ? "" : selectedEffort ?? ""}
            onChange={(event) => setEffort(event.target.value)}>
            {automatic && <option value="">По настройкам BB</option>}
            {!automatic && !levels.length && <option value="">{loading ? "Загрузка…" : "Недоступен для этой модели"}</option>}
            {levels.map((level) => (
              <option key={level.reasoningEffort} value={level.reasoningEffort}>{level.label ?? level.reasoningEffort}</option>
            ))}
          </select>
        </label>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <footer>
        {saved && <span role="status">Сохранено</span>}
        <button type="button" disabled={saving} onClick={onCancel}>Отмена</button>
        <button type="submit" disabled={saving || !canSave}>{saving ? "Сохранение…" : "Сохранить"}</button>
      </footer>
    </form>
  );
}

const serverSelection: ComposerSelection = {};

function SystemChatSettings() {
  const { data, error, refetch } = useChatDefaults();
  const [revision, setRevision] = useState(0);
  if (data === undefined) {
    return error ? (
      <div className="chat-defaults-form">
        <p role="alert">Не удалось загрузить настройки.</p>
        <button type="button" onClick={() => void refetch()}>Повторить</button>
      </div>
    ) : <p role="status">Загрузка настроек…</p>;
  }
  return (
    <SettingsForm key={revision} initial={data} current={serverSelection}
      onCancel={() => setRevision((value) => value + 1)} onSaved={refetch} />
  );
}

export function KanbanSettings() {
  return <div className="kanban-settings">
    <WindowPlacementSettings />
    <section aria-labelledby="kanban-chat-defaults-title">
      <h3 id="kanban-chat-defaults-title">Новые чаты</h3>
      <p className="kanban-settings-hint">Модель, уровень усилия и скорость по умолчанию для новых чатов во всех разделах.</p>
      <SystemChatSettings />
    </section>
    <p className="kanban-settings-hint">Обновления канбана доступны в настройках установленных плагинов BB.</p>
  </div>;
}

function ProjectChatSettings({ composer }: { composer: ReturnType<typeof useComposer> }) {
  const sdk = useSdk();
  const { data: saved, error, refetch } = useChatDefaults();
  const [editing, setEditing] = useState<ComposerSelection | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const initialized = useRef(false);
  const baseline = useRef<ComposerSelection | null>(null);
  const pending = useRef<AbortController | null>(null);
  const [applying, setApplying] = useState(false);

  const selectionReady = Boolean(composer.selection?.providerId && composer.selection.model);
  useLayoutEffect(() => () => {
    if (pending.current) {
      pending.current.abort();
      pending.current = null;
      initialized.current = false;
      composer.setInputLock(false);
    }
  }, [composer]);

  useLayoutEffect(() => {
    const current = composer.selection;
    if (initialized.current || saved === undefined || !selectionReady || !current) return;
    initialized.current = true;
    baseline.current = current;
    if (!saved) return;

    const abort = new AbortController();
    pending.current = abort;
    setApplying(true);
    composer.setInputLock(true);
    void resolvePreference(sdk.providers, current, saved, abort.signal)
      .then((preferred) => {
        if (!abort.signal.aborted && preferred && sameExecution(current, composer.selection)) {
          return composer.setSelection(preferred);
        }
      })
      .catch(() => {
        // BB's native selection remains usable when its catalog cannot be read.
      })
      .finally(() => {
        if (!abort.signal.aborted) {
          pending.current = null;
          baseline.current = composer.selection;
          composer.setInputLock(false);
          setApplying(false);
        }
      });
  }, [composer, saved, sdk, selectionReady]);

  useLayoutEffect(() => {
    if (editing) dialog.current?.showModal();
  }, [editing]);

  return (
    <div className="chat-defaults-settings">
      <button type="button" disabled={applying || saved === undefined || !selectionReady}
        onClick={() => setEditing(composer.selection)}>
        Настройки
      </button>
      {applying && <span role="status">Загрузка настроек чата…</span>}
      {error && saved === undefined && (
        <button type="button" onClick={() => void refetch()}>Повторить загрузку настроек</button>
      )}
      {editing && (
        <dialog ref={dialog} aria-labelledby="chat-defaults-title" onClose={() => setEditing(null)}>
          <h2 id="chat-defaults-title">Настройки</h2>
          <p>Параметры для новых чатов во всех разделах BB.</p>
          <SettingsForm initial={saved ?? null} current={editing} onCancel={() => dialog.current?.close()}
            onSaved={async (value) => {
              if (value && baseline.current && sameExecution(baseline.current, composer.selection)) {
                try {
                  baseline.current = await composer.setSelection(value);
                } catch {
                  // The saved preference will be resolved again in the next draft.
                }
              }
              dialog.current?.close();
            }} />
        </dialog>
      )}
    </div>
  );
}

function NewChatSettings() {
  const composer = useComposer();
  if (composer.scope.kind !== "new-thread") return null;
  return <ProjectChatSettings key={composer.scope.projectId} composer={composer} />;
}

export const registerSettingsUi: Parameters<typeof definePluginApp>[0] = (app) => {
  app.slots.settingsSection({
    id: "new-chat-defaults",
    title: "Настройки канбана",
    description: "Расположение окон и параметры новых чатов. Все настройки входят в плагин канбана.",
    component: KanbanSettings,
  });
  app.composer.customize({
    id: "new-chat-settings",
    scopes: ["new-thread"],
    banners: [{ id: "settings", chrome: "bare", component: NewChatSettings }],
  });
};
