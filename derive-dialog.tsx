import { useState } from "react";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import type { DeriveRequest, DeriveSource } from "./issues";
import type { CardActionGroup } from "./kanban-ui";

export type DeriveSelection = Omit<DeriveRequest, "instruction"> & { title: string };
export type DeriveDialogRequest = { selection: DeriveSelection; trigger: HTMLButtonElement | null };
export type OpenDerivation = (request: DeriveDialogRequest) => void;

export function contextActions(source: DeriveSource, title: string, open: OpenDerivation): CardActionGroup {
  return {
    label: "Подзадачи из контекста",
    items: [
      { label: "Породить задачу", action: (trigger) => open({ selection: { source, title, mode: "single" }, trigger }) },
      { label: "Сделать декомпозицию", action: (trigger) => open({ selection: { source, title, mode: "decompose" }, trigger }) },
    ],
  };
}

export function DeriveDialog({ request: { selection, trigger }, close, start }: {
  request: DeriveDialogRequest;
  close: () => void;
  start: (selection: DeriveSelection, instruction: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [instruction, setInstruction] = useState("");
  const decompose = selection.mode === "decompose";
  const title = decompose ? "Сделать декомпозицию" : "Породить задачу";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="kb-dialog max-h-[85vh] overflow-y-auto"
        onAfterCloseAutoFocus={() => {
          trigger?.focus({ preventScroll: true });
          close();
        }}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="break-words">Источник · {selection.title}</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(event) => {
          event.preventDefault();
          if (!decompose && !instruction.trim()) return;
          start({ ...selection, test: false }, instruction.trim());
          setOpen(false);
        }}>
          <label className="block space-y-1.5 text-sm">
            <span>{decompose ? "Уточнение · необязательно" : "Что нужно сделать?"}</span>
            <textarea className="w-full rounded-md border border-input bg-background p-2 text-sm"
              rows={4} maxLength={6000} required={!decompose} value={instruction}
              placeholder={decompose ? "Например, разложи на задачи только этап проверки." : "Опиши результат, который нужен от новой задачи."}
              onChange={(event) => setInstruction(event.target.value)} />
          </label>
          <p className="text-xs text-muted-foreground">{decompose
            ? "Если оставить поле пустым, агент разберёт задачу целиком. Подзадачи появятся в её дереве."
            : "Агент использует исходный контекст, подготовит план и промпт запуска, затем добавит подзадачу в дерево."}</p>
          <DialogFooter>
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>Отмена</Button>
            <Button type="submit" size="sm" disabled={!decompose && !instruction.trim()}>
              {decompose ? "Разложить на задачи" : "Подготовить задачу"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
