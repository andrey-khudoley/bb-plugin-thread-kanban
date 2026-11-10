import { useState } from "react";
import { experimental_useAppPanel, experimental_useRpcQuery, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { issueRpc, type Issue } from "./issues";
import { issueTitle } from "./issue-tree";
import { sectionId } from "./panel-context-actions";
import { sectionStore } from "./panel-context";

export function DeleteIssueDialog({ issue, close, deleted }: {
  issue: Issue;
  close: () => void;
  deleted: (issue: Issue) => void;
}) {
  const panel = experimental_useAppPanel();
  const rpc = useRpc<typeof issueRpc>();
  const preview = experimental_useRpcQuery({ contract: issueRpc, method: "issueDeletePreview", input: { id: issue.id } });
  const plan = preview.data;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    if (pending || issue.busy || !plan || preview.isFetching || preview.error) return;
    setPending(true);
    setError("");
    try {
      await rpc.call("issueDelete", { id: issue.id, confirmation: plan.confirmation });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(false);
      void preview.refetch();
      return;
    }
    for (const tab of panel.getTabs().tabs) {
      const id = sectionId(tab);
      const context = id && sectionStore.get(id).context;
      if (id && context && context.kind === 'issue' && context.issueId === issue.id) sectionStore.clear(id);
    }
    deleted(issue);
    close();
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) close(); }}>
      <DialogContent className="kb-dialog">
        <DialogHeader>
          <DialogTitle>Удалить карточку?</DialogTitle>
          <DialogDescription className="break-words">
            Карточка «{issueTitle(issue)}» будет удалена вместе с планом и связями.
            {plan && plan.chats > 0 && " Связанные чаты будут удалены без возможности восстановления."}
            {plan && plan.worktrees > 0 && " BB удалит связанные worktree, которые используются только этой карточкой."}
            {" Подзадачи сохранятся."}
          </DialogDescription>
        </DialogHeader>
        {preview.isLoading && <p role="status" className="text-sm text-muted-foreground">Проверяю связанные чаты и worktree…</p>}
        {!!plan?.warnings.length && <div role="alert" className="space-y-1 break-words text-sm text-destructive">
          <p>При удалении можно потерять изменения, которых нет в main.</p>
          <ul className="list-disc pl-5">{plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </div>}
        {(error || preview.error || issue.busy) && <p role="alert" className="break-words text-sm text-destructive">
          {error || preview.error?.message || "Дождись завершения текущего действия."}
        </p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={close}>Отмена</Button>
          <Button type="button" variant="destructive" disabled={pending || !!issue.busy || !plan || preview.isFetching || !!preview.error}
            onClick={() => void remove()}>
            {pending ? "Удаляю…" : plan?.warnings.length ? "Подтвердить" : "Удалить карточку"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
