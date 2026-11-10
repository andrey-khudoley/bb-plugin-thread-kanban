/** Window-local membership. Each visible chat instance owns a separate lease. */
export function createOpenChatStore() {
  const owners = new Map<symbol, string>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlySet<string> = new Set();

  function publish() {
    const next = new Set(owners.values());
    if (next.size === snapshot.size && [...next].every((id) => snapshot.has(id))) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    open(threadId: string) {
      const owner = Symbol(threadId);
      owners.set(owner, threadId);
      publish();
      return () => {
        if (owners.delete(owner)) publish();
      };
    },
  };
}

export const openChatStore = createOpenChatStore();
