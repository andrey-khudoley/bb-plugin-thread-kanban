type Item = { id: string; updatedAt: number; createdAt: number; priority?: string | null; order?: number; stage?: string };
const rank = (priority?: string | null) => ({ urgent: 0, high: 1, normal: 2, low: 3 }[priority ?? ""] ?? 4);
const stageRank = (stage?: string) => ["backlog", "todo", "working", "review", "done", "cancelled"].indexOf(stage ?? "");

/** List order applies across stages and card kinds inside each project. */
export function compareListItems(a: Item, b: Item, sort: string) {
  if (sort === "priority" && rank(a.priority) !== rank(b.priority)) return rank(a.priority) - rank(b.priority);
  if (sort === "created" && a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (sort === "manual") {
    if (a.stage !== b.stage) return stageRank(a.stage) - stageRank(b.stage);
    if (a.order !== undefined && b.order !== undefined && a.order !== b.order) return a.order - b.order;
    if ((a.order === undefined) !== (b.order === undefined)) return a.order === undefined ? 1 : -1;
  }
  return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}
