import { z } from "zod";

export const panelContext = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat"), threadId: z.string(), title: z.string(),
    view: z.enum(['chat','changes','plan']).optional() }),
  z.object({ kind: z.literal("issue"), issueId: z.string(), title: z.string(),
    threadId: z.string().nullable(), startWithAssistant: z.boolean(), request: z.number(),
    view: z.enum(['chat','changes','plan','overview','planning','relations','work']).optional() }),
]);
export type PanelContext = z.infer<typeof panelContext>;
export function contextThreadId(context: PanelContext | null) {
  if (context?.kind === 'chat') return context.threadId;
  return context?.kind === 'issue' && (!context.view || ['chat','changes','plan'].includes(context.view)) ? context.threadId : null;
}
const sectionSchema = z.object({
  initialized: z.boolean().default(true),
  context: panelContext.nullable(),
  files: z.record(z.string(), z.array(z.string())),
  fileOwnerVersion: z.number().default(1),
});
export type PanelSection = z.infer<typeof sectionSchema>;
export const contextKey = (context: PanelContext) => context.kind === "chat"
  ? `chat:${context.threadId}` : `issue:${context.issueId}`;

/** Persist identities and file membership; native tab lifetime and buffers stay owned by BB. */
export function createSectionStore(storage: () => Storage = () => localStorage) {
  const sections = new Map<string, PanelSection>();
  const fileSets = new Map<string, string[]>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const key = (id: string) => `thread-kanban:section:v1:${id}`;
  const fileKey = (owner: string) => `thread-kanban:card-files:v1:${owner}`;
  let savedFilesLoaded = false;
  function loadSavedFiles() {
    if (savedFilesLoaded) return;
    savedFilesLoaded = true;
    try {
      const browser = storage();
      const prefix = 'thread-kanban:card-files:v1:';
      for (let index = 0; index < browser.length; index++) {
        const savedKey = browser.key(index);
        if (!savedKey?.startsWith(prefix)) continue;
        try { fileSets.set(savedKey.slice(prefix.length), z.array(z.string()).parse(JSON.parse(browser.getItem(savedKey) ?? '[]'))); }
        catch { /* Ignore only the malformed card file set. */ }
      }
    } catch { /* Storage can be unavailable. */ }
  }
  function filesFor(owner: string) {
    loadSavedFiles();
    let files = fileSets.get(owner);
    if (!files) {
      try { files = z.array(z.string()).parse(JSON.parse(storage().getItem(fileKey(owner)) ?? '[]')); } catch { /* New file set. */ }
      files ??= [];
      fileSets.set(owner, files);
    }
    return files;
  }
  function saveFiles(owner: string, files: string[]) {
    fileSets.set(owner, files);
    try { storage().setItem(fileKey(owner), JSON.stringify(files)); } catch { /* Keep file ownership in memory. */ }
  }
  function publish() { revision++; listeners.forEach((listener) => listener()); }
  function get(id: string): PanelSection {
    let section = sections.get(id);
    if (!section) {
      try { section = sectionSchema.parse(JSON.parse(storage().getItem(key(id)) ?? "null")); } catch { /* New section. */ }
      section ??= { initialized: false, context: null, files: {}, fileOwnerVersion: 2 };
      if (section.fileOwnerVersion < 2) {
        for (const [oldOwner, paths] of Object.entries(section.files)) {
          const context = section.context;
          const owner = context?.kind === 'issue' && oldOwner === `chat:${context.threadId}` ? contextKey(context) : oldOwner;
          saveFiles(owner, [...new Set([...filesFor(owner), ...paths])]);
        }
        section = { ...section, fileOwnerVersion: 2 };
        try { storage().setItem(key(id), JSON.stringify(section)); } catch { /* In-memory migration is sufficient. */ }
      }
      for (const owner of Object.keys(section.files)) filesFor(owner);
      if (section.context) filesFor(contextKey(section.context));
      sections.set(id, section);
    }
    return section;
  }
  function set(id: string, section: PanelSection) {
    sections.set(id, section);
    try { storage().setItem(key(id), JSON.stringify(section)); } catch { /* Keep the live session usable. */ }
    publish();
  }
  return {
    get,
    getSnapshot: () => revision,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    replace(id: string, context: PanelContext) { filesFor(contextKey(context)); set(id, { ...get(id), initialized: true, context }); },
    clear(id: string) { set(id, { ...get(id), initialized: true, context: null }); },
    absorb(id: string, previousId: string) {
      const section = get(id);
      const previous = get(previousId);
      const files = { ...section.files };
      for (const [owner, paths] of Object.entries(previous.files)) files[owner] = [...new Set([...(files[owner] ?? []), ...paths])];
      if (JSON.stringify(files) !== JSON.stringify(section.files)) set(id, { ...section, files });
    },
    remember(id: string, path: string) {
      const section = get(id);
      if (!section.context) return;
      const owner = contextKey(section.context);
      const files = filesFor(owner);
      if (!files.includes(path)) {
        const next = [...files, path];
        saveFiles(owner, next);
        set(id, { ...section, files: { ...section.files, [owner]: next } });
      }
    },
    forget(id: string, path: string) {
      get(id);
      loadSavedFiles();
      // A native editor close removes that file from every card sharing the same editor.
      for (const [owner, files] of fileSets) if (files.includes(path)) saveFiles(owner, files.filter((p) => p !== path));
      for (const [sectionId, section] of sections) {
        const files = Object.fromEntries(Object.entries(section.files).map(([owner, paths]) => [owner, paths.filter((p) => p !== path)]));
        if (Object.keys(files).some((owner) => files[owner].length !== section.files[owner].length)) set(sectionId, { ...section, files });
      }
      publish();
    },
    isKnownFile(path: string) { loadSavedFiles(); return [...fileSets.values()].some((files) => files.includes(path)); },
    hasFile(id: string, path: string) {
      const section = get(id);
      return !!section.context && filesFor(contextKey(section.context)).includes(path);
    },
  };
}

export const sectionStore = createSectionStore();
