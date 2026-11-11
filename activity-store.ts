import { z } from 'zod';
import type { DeriveSelection } from './derive-dialog';
import type { DeriveResult } from './issues';

export type ActivityRun = {
  key: number; scope: string; selection: DeriveSelection; instruction?: string;
  jobId?: string; result?: DeriveResult; error?: string; pollError?: boolean; hidden?: boolean;
};
const savedRun = z.object({
  key: z.number(), scope: z.string().default('board'), jobId: z.uuid().optional(),
  hidden: z.boolean().optional(),
  selection: z.object({ source: z.object({ kind: z.enum(['thread', 'issue']), id: z.string() }),
    mode: z.enum(['single', 'decompose']), title: z.string(), test: z.boolean().optional() }),
});
const storageKey = 'thread-kanban:notifications:v1';

export function createActivityStore(storage?: Storage) {
  let runs: ActivityRun[] = [];
  let sequence = 0;
  const listeners = new Set<() => void>();
  try {
    const saved = storage?.getItem(storageKey);
    if (saved) runs = savedRun.array().parse(JSON.parse(saved));
    else if (storage) {
      // Preserve pending jobs from the former per-pane activity panels.
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key?.startsWith('thread-kanban:derivations:')) continue;
        const legacy = JSON.parse(storage.getItem(key) ?? '{}');
        for (const run of Array.isArray(legacy.runs) ? legacy.runs : []) {
          const parsed = savedRun.safeParse({ ...run, key: ++sequence,
            scope: key.slice('thread-kanban:derivations:'.length), jobId: run.id });
          if (parsed.success && !runs.some(item => item.jobId === parsed.data.jobId)) runs.push(parsed.data);
        }
      }
    }
  } catch { /* Storage can be unavailable or contain an older, invalid value. */ }
  sequence = Math.max(sequence, 0, ...runs.map(run => run.key));
  const publish = () => {
    try { storage?.setItem(storageKey, JSON.stringify(runs.flatMap(run => run.jobId
      ? [{ key: run.key, scope: run.scope, selection: run.selection, jobId: run.jobId, hidden: run.hidden }] : []))); } catch { /* Session still works. */ }
    listeners.forEach(listener => listener());
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => runs,
    add(scope: string, selection: DeriveSelection, instruction: string) {
      const existing = runs.find(run => !run.error && (!run.result || run.result.status === 'running') &&
        run.selection.source.kind === selection.source.kind && run.selection.source.id === selection.source.id &&
        run.selection.mode === selection.mode && !!run.selection.test === !!selection.test && run.instruction === instruction);
      if (existing) return { key: existing.key, created: false };
      const key = ++sequence;
      runs = [{ key, scope, selection, instruction }, ...runs]; publish();
      return { key, created: true };
    },
    update(key: number, value: Partial<ActivityRun>) {
      runs = runs.filter(run => !value.jobId || run.key === key || run.jobId !== value.jobId)
        .map(run => run.key === key ? { ...run, ...value } : run); publish();
    },
    dismiss(key: number) { runs = runs.filter(run => run.key !== key); publish(); },
    hide(key: number) { runs = runs.map(run => run.key === key ? { ...run, hidden: true } : run); publish(); },
    hideAll() { runs = runs.map(run => ({ ...run, hidden: true })); publish(); },
    view(targets: { threadIds: readonly string[]; issueIds: readonly string[] }) {
      let changed = false;
      const next = runs.map(run => {
        if (run.hidden) return run;
        const failed = !!run.error || run.result?.status === 'failed';
        const done = run.result?.status === 'done';
        if (!failed && !done) return run;
        const matches = (kind: string, id: string) => (kind === 'thread' ? targets.threadIds : targets.issueIds).includes(id);
        const childViewed = done && run.result?.children.some(child => targets.issueIds.includes(child.id) ||
          child.threadIds.some(id => targets.threadIds.includes(id)));
        if (!childViewed && !((failed || !run.result?.children.length) && matches(run.selection.source.kind, run.selection.source.id))) return run;
        changed = true; return { ...run, hidden: true };
      });
      if (changed) { runs = next; publish(); }
    },
  };
}

let singleton: ReturnType<typeof createActivityStore> | undefined;
export function activityStore() {
  if (!singleton) {
    let storage: Storage | undefined;
    try { storage = sessionStorage; } catch { /* SSR and private browsers. */ }
    singleton = createActivityStore(storage);
  }
  return singleton;
}
