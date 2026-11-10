/** Saved IDs come first; new projects keep their incoming order at the end. */
export function orderProjects<T extends { id: string }>(projects: readonly T[], saved: readonly string[]): T[] {
  const remaining = new Map(projects.map((project) => [project.id, project]));
  const ordered: T[] = [];
  for (const id of saved) {
    const project = remaining.get(id);
    if (!project) continue;
    ordered.push(project);
    remaining.delete(id);
  }
  return [...ordered, ...remaining.values()];
}

export function moveProject(ids: readonly string[], id: string, direction: "up" | "down"): string[] {
  const next = [...ids];
  const index = next.indexOf(id);
  const target = index + (direction === "up" ? -1 : 1);
  if (index >= 0 && target >= 0 && target < next.length) {
    [next[index], next[target]] = [next[target], next[index]];
  }
  return next;
}
