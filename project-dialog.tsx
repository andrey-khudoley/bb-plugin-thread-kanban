import { useState } from "react";
import { experimental_useRpcQuery, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { projectName, projectRpc } from "./projects";

export type ProjectDialogTarget = { id: string; name: string; kind: "rename" | "remove" | "restore" };

export function ProjectDialog({ target, close, changed, restoreProjects = [] }: {
  target: ProjectDialogTarget; close: () => void; changed: (mode?: "personal" | "delete") => void;
  restoreProjects?: { id: string; name: string }[];
}) {
  const rpc = useRpc<typeof projectRpc>();
  const [name, setName] = useState(target.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const removing = target.kind === "remove";
  const restoring = target.kind === "restore";
  const [restoreId, setRestoreId] = useState(restoreProjects[0]?.id ?? "");
  const preview = experimental_useRpcQuery({
    contract: projectRpc, method: "projectRemovalPreview", input: { projectId: target.id }, enabled: removing,
  });
  const plan = preview.data;
  const canSave = removing ? !!plan && !preview.error && !preview.isFetching : restoring ? !!restoreId : projectName.safeParse(name).success;
  async function save() {
    if (pending || !canSave) return;
    setPending(true);
    setError("");
    try {
      if (removing && plan) {
        const result = await rpc.call("projectRemove", { projectId: target.id, confirmation: plan.confirmation });
        changed(result.mode);
      } else if (restoring) {
        await rpc.call("projectRestore", { projectId: restoreId });
        changed();
      } else {
        await rpc.call("projectRename", { projectId: target.id, name });
        changed();
      }
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(false);
      if (removing) void preview.refetch();
    }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !pending) close(); }}>
    <DialogContent className="kb-dialog" onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }}>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <DialogHeader>
          <DialogTitle>{restoring ? "Вернуть проект в канбан" : removing
            ? !plan ? "Проверяю проект…" : plan.mode === "personal" ? "Убрать проект в Personal?" : "Удалить проект?"
            : "Переименовать проект"}</DialogTitle>
          <DialogDescription className="break-words">
            {restoring ? "Выбери проект, чтобы снова показать его задачи и чаты отдельной группой."
              : removing ? !plan ? `Проверяю задачи и все чаты проекта «${target.name}», включая архивные и скрытые.`
                : plan.mode === "personal"
                  ? `В канбане задачи и чаты проекта «${plan.name}» будут показаны в Personal. Сам проект и принадлежность чатов в BB сохранятся. Вернуть группу можно через меню Personal.`
                  : `В проекте «${plan.name}» нет чатов, включая архивные и скрытые. Проект будет удалён из BB. Его задачи (${plan.tasks}) сохранятся в Personal.`
                : `Новое название проекта «${target.name}» появится во всём приложении.`}
          </DialogDescription>
        </DialogHeader>
        {target.kind === "rename" && <div className="my-4 space-y-1">
          <label htmlFor="kb-project-name" className="text-sm">Название проекта</label>
          <Input id="kb-project-name" autoFocus value={name} disabled={pending}
            onFocus={(event) => event.target.select()} onChange={(event) => setName(event.target.value)} />
          {!name.trim() && <p className="text-sm text-destructive">Введи название проекта.</p>}
        </div>}
        {restoring && <select aria-label="Проект для возврата" value={restoreId} disabled={pending}
          className="my-4 h-9 w-full rounded-md border border-input bg-background px-2 text-sm" onChange={(event) => setRestoreId(event.target.value)}>
          {restoreProjects.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select>}
        {(error || (removing && preview.error)) && <p role="alert" className="my-3 text-sm text-destructive">{error || preview.error?.message}</p>}
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" disabled={pending} onClick={close}>Отмена</Button>
          <Button type="submit" variant={removing && plan?.mode === "delete" ? "destructive" : "default"} disabled={pending || !canSave}>
            {pending ? "Сохраняю…" : restoring ? "Вернуть проект" : removing
              ? plan?.mode === "delete" ? "Удалить проект" : "Убрать в Personal" : "Сохранить"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
