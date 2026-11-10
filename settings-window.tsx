import { useState } from "react";
import { experimental_useRpcQuery, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { windowPlacement, windowPlacementChanged, windowPlacementContract, defaultPaneHeaders } from "./settings-contract";

function PaneHeaderSettings() {
  const query = experimental_useRpcQuery({ contract: windowPlacementContract, method: "readPaneHeaders", input: null });
  const rpc = useRpc<typeof windowPlacementContract>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useRealtime(windowPlacementChanged, () => void query.refetch());
  return <fieldset disabled={saving} className="kanban-pane-header-settings">
    <legend>Шапки при горизонтальном разделении</legend>
    {(['top', 'bottom'] as const).map((position) => <label key={position} className="kanban-pane-header-option">
      <input type="checkbox" disabled={query.data === undefined} checked={(query.data ?? defaultPaneHeaders)[position]} onChange={async (event) => {
        const value = { ...(query.data ?? defaultPaneHeaders), [position]: event.target.checked };
        setSaving(true); setError(""); setSaved(false);
        try { await rpc.call("savePaneHeaders", value); await query.refetch(); setSaved(true); }
        catch { setError("Не удалось сохранить расположение шапок."); }
        finally { setSaving(false); }
      }} />
      <span>{position === 'top' ? 'Шапка верхней панели справа' : 'Шапка нижней панели справа'}</span>
    </label>)}
    <p className="kanban-settings-hint">Выключенный переключатель оставляет шапку сверху. Выбор применяется при следующем открытии из канбана. Каждую шапку можно скрыть отдельно у разделителя.</p>
    {(saving || saved) && <p role="status">{saving ? 'Сохранение…' : 'Сохранено'}</p>}
    {(error || query.error) && <p role="alert">{error || 'Не удалось загрузить расположение шапок.'}</p>}
    {query.error && <button type="button" disabled={saving} onClick={() => void query.refetch()}>Повторить загрузку</button>}
  </fieldset>;
}

export function WindowPlacementSettings() {
  const query = experimental_useRpcQuery({ contract: windowPlacementContract, method: "readWindowPlacement", input: null });
  const rpc = useRpc<typeof windowPlacementContract>();
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  useRealtime(windowPlacementChanged, () => void query.refetch());
  return <section aria-labelledby="kanban-window-placement-title" className="chat-defaults-form">
    <h3 id="kanban-window-placement-title">Открываемые окна</h3>
    <label htmlFor="kanban-window-placement">Расположение открываемых окон</label>
    <select id="kanban-window-placement" aria-describedby="kanban-window-placement-hint"
      disabled={query.data === undefined || saving} value={query.data ?? "right"}
      onChange={async (event) => {
        const value = windowPlacement.parse(event.target.value);
        setSaving(true); setStatus(""); setError("");
        try {
          await rpc.call("saveWindowPlacement", value);
          await query.refetch();
          setStatus("Сохранено");
        } catch { setError("Не удалось сохранить расположение окон. Повтори выбор."); }
        finally { setSaving(false); }
      }}>
      <option value="right">Справа от канбана</option>
      <option value="below">Под канбаном</option>
      <option value="above">Над канбаном</option>
    </select>
    <p id="kanban-window-placement-hint" className="kanban-settings-hint">
      Для чатов, карточек и других вкладок панели канбана. Применяется при следующем открытии;
      смена настройки сама по себе не перемещает окна. Выбор сохраняется автоматически.
    </p>
    {(saving || status) && <p role="status">{saving ? "Сохранение…" : status}</p>}
    {(error || query.error) && <p role="alert">{error || "Не удалось загрузить расположение окон."}</p>}
    {query.error && <button type="button" onClick={() => void query.refetch()}>Повторить загрузку</button>}
    <PaneHeaderSettings />
  </section>;
}
