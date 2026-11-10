/** Activity belongs to one native panel surface, never to persisted tab keys. */
export function createTabActivity() {
  const activated = new Map<string, number>();
  let selected: string | null = null;
  let sequence = 0;
  return {
    update(tabs: readonly { key: string }[], selectedKey: string | null) {
      const live = new Set(tabs.map((tab) => tab.key));
      for (const key of activated.keys()) if (!live.has(key)) activated.delete(key);
      if (selectedKey !== selected && selectedKey !== null && live.has(selectedKey)) activated.set(selectedKey, ++sequence);
      selected = selectedKey;
    },
    rank(key: string) { return activated.get(key) ?? 0; },
  };
}
export type TabActivity = ReturnType<typeof createTabActivity>;

export function matchingCardTabs<T extends { key: string; cardKey: string | null }>(
  tabs: readonly T[], target: string, selectedKey: string | null, activity?: TabActivity,
): T[] {
  // Stable sort leaves snapshot order as the deterministic fallback after restoration.
  return tabs.filter((tab) => tab.cardKey === target).sort((a, b) =>
    Number(b.key === selectedKey) - Number(a.key === selectedKey)
    || (activity?.rank(b.key) ?? 0) - (activity?.rank(a.key) ?? 0));
}
