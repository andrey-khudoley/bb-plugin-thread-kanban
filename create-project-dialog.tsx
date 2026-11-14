import { useEffect, useRef, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { projectName } from "./projects";

type Machine = { id: string; name: string; status: "connected" | "disconnected" };
export type CreatedProject = { id: string; name: string };

export function CreateProjectDialog({ close, created }: {
  close: () => void; created: (project: CreatedProject) => void;
}) {
  const sdk = useSdk();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [hostId, setHostId] = useState("");
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const pathInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  function closeDialog() {
    const trigger = document.querySelector<HTMLButtonElement>(".kb-create-project");
    close();
    // The compact drawer does not forward Radix's onCloseAutoFocus. Restore
    // after its focus trap is removed, keeping this exact board's trigger.
    requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus(); });
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    void sdk.hosts.list({ signal: controller.signal }).then((hosts) => {
      if (controller.signal.aborted) return;
      setMachines(hosts);
      setHostId((previous) => hosts.some((host) => host.id === previous && host.status === "connected")
        ? previous : hosts.find((host) => host.status === "connected")?.id ?? "");
    }).catch((cause) => {
      if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sdk, attempt]);
  const nameError = projectName.safeParse(name).success ? "" : "Введи название раздела.";
  const folder = path.trim();
  const pathError = !folder ? "Укажи папку раздела." : !/^(?:[a-z]:[\\/]|\/|\\\\[^\\]+\\[^\\]+)/i.test(folder)
    ? "Укажи полный путь к папке на выбранном компьютере." : "";
  const connected = machines.some((machine) => machine.id === hostId && machine.status === "connected");
  async function save() {
    if (saving.current) return;
    setSubmitted(true);
    if (nameError || pathError || !connected || loading || loadError) {
      if (nameError) nameInput.current?.focus();
      else if (pathError) pathInput.current?.focus();
      return;
    }
    // A synchronous guard also covers repeated Enter/clicks before React renders.
    saving.current = true;
    setPending(true);
    setError("");
    try {
      // Core creation accepts an unverified source path. Check the folder first
      // so an inaccessible/missing source cannot leave a half-configured project.
      await sdk.hosts.directory({ hostId, path: folder }).catch((cause) => {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`Папка недоступна на выбранном компьютере. Проверь путь и права доступа. ${detail}`);
      });
      const project = await sdk.projects.create({ name: name.trim(), source: { type: "local_path", hostId, path: folder } });
      created(project);
      closeDialog();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      saving.current = false;
      setPending(false);
    }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !saving.current) closeDialog(); }}>
    <DialogContent className="kb-dialog kb-create-project-dialog" hideCloseButton={pending}
      onEscapeKeyDown={(event) => { if (saving.current) event.preventDefault(); }}
      onCloseAutoFocus={(event) => {
        const trigger = document.querySelector<HTMLButtonElement>(".kb-create-project");
        if (trigger) { event.preventDefault(); trigger.focus(); }
      }}>
      <form noValidate aria-busy={pending} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <DialogHeader>
          <DialogTitle>Создать раздел</DialogTitle>
          <DialogDescription>Введи название и укажи существующую папку раздела на подключённом компьютере.</DialogDescription>
        </DialogHeader>
        <div className="my-4 space-y-4">
          <div className="space-y-1">
            <label htmlFor="kb-create-project-name">Название раздела</label>
            <Input ref={nameInput} id="kb-create-project-name" autoFocus required value={name} disabled={pending}
              aria-invalid={submitted && !!nameError} aria-describedby={submitted && nameError ? "kb-create-name-error" : undefined}
              onChange={(event) => setName(event.target.value)} />
            {submitted && nameError && <p id="kb-create-name-error" role="alert" className="text-sm text-destructive">{nameError}</p>}
          </div>
          <div className="space-y-1">
            <label htmlFor="kb-create-project-machine">Компьютер</label>
            <select id="kb-create-project-machine" required value={hostId} disabled={pending || loading}
              className="w-full rounded-md border border-input bg-background px-2 text-sm"
              onChange={(event) => setHostId(event.target.value)}>
              <option value="" disabled>{loading ? "Загружаю компьютеры…" : "Выбери компьютер"}</option>
              {machines.map((machine) => <option key={machine.id} value={machine.id} disabled={machine.status !== "connected"}>
                {machine.name}{machine.status !== "connected" ? " · Не в сети" : ""}
              </option>)}
            </select>
            {!loading && !loadError && !connected && <p role="status" className="text-sm text-muted-foreground">Нет подключённого компьютера. Подключи его в BB и обнови список.</p>}
            {loadError && <p role="alert" className="text-sm text-destructive">Не удалось загрузить компьютеры: {loadError}</p>}
            {!loading && (loadError || !connected) && <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>Обновить компьютеры</Button>}
          </div>
          <div className="space-y-1">
            <label htmlFor="kb-create-project-path">Папка раздела</label>
            <Input ref={pathInput} id="kb-create-project-path" required value={path} disabled={pending}
              placeholder="Полный путь к существующей папке" spellCheck={false}
              aria-invalid={submitted && !!pathError} aria-describedby={submitted && pathError ? "kb-create-path-error" : undefined}
              onChange={(event) => setPath(event.target.value)} />
            {submitted && pathError && <p id="kb-create-path-error" role="alert" className="text-sm text-destructive">{pathError}</p>}
          </div>
        </div>
        {error && <p role="alert" className="my-3 break-words text-sm text-destructive">Не удалось создать раздел: {error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={closeDialog}>Отмена</Button>
          <Button type="submit" disabled={pending || loading || !connected || !!loadError}>{pending ? "Создаю…" : "Создать раздел"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
