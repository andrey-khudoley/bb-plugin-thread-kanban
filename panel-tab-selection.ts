type ContextTab = { key: string; contextId: string | null; kind: string };

/** Select a replacement target without removing any explicitly opened tabs. */
export function replacementTabKey(
  tabs: readonly ContextTab[], selectedKey: string | null, focusedId: string | null,
  fileOwners: ReadonlyMap<string, string>, groups: ReadonlyMap<string, string>,
) {
  const selected = tabs.find((tab) => tab.key === selectedKey);
  if (selected?.kind === 'new-tab') return null;
  const focused = tabs.some((tab) => tab.contextId === focusedId) ? focusedId : null;
  const id = focused ?? selected?.contextId ?? (selected?.kind === 'file' ? fileOwners.get(selected.key) : null)
    ?? (selectedKey ? groups.get(selectedKey) : null);
  return tabs.find((tab) => tab.contextId !== null && tab.contextId === id)?.key ?? null;
}
