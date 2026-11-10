export function createDraftStore<T>(
  namespace: string,
  empty: T,
  parse: (value: unknown) => T,
  storage: () => Storage = () => sessionStorage,
) {
  const drafts = new Map<string, ReturnType<typeof open>>();

  function open(id: string) {
    const key = `thread-kanban:draft:${namespace}:${id}`;
    const listeners = new Set<() => void>();
    let current = empty;
    try {
      const saved = storage().getItem(key);
      if (saved !== null) current = parse(JSON.parse(saved));
    } catch { /* The in-memory draft also works without browser storage. */ }

    function update(change: (value: T) => T) {
      const next = change(current);
      if (Object.is(next, current)) return;
      current = next;
      try {
        if (Object.is(next, empty)) storage().removeItem(key);
        else storage().setItem(key, JSON.stringify(next));
      } catch { /* Keep the latest draft in memory. */ }
      listeners.forEach((listener) => listener());
    }

    return {
      get: () => current,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      update,
      clear: (submitted?: T) => update((value) => submitted === undefined || Object.is(value, submitted) ? empty : value),
    };
  }

  return (id: string) => {
    const existing = drafts.get(id);
    if (existing) return existing;
    const draft = open(id);
    drafts.set(id, draft);
    return draft;
  };
}
