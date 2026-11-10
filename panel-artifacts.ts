import { z } from 'zod';

/** Session-only identities. BB owns native tab lifetime and editor buffers. */
export type ArtifactSelection = string | null;
export function createArtifactStore() {
  const selections = new Map<string, ArtifactSelection>();
  const listeners = new Set<() => void>();
  let revision = 0;
  return {
    getSnapshot: () => revision,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get(owner: string) { return selections.get(owner) ?? null; },
    select(owner: string, key: ArtifactSelection) {
      if ((selections.get(owner) ?? null) === key) return;
      selections.set(owner, key); revision++; listeners.forEach(listener => listener());
    },
  };
}
export function afterArtifactClose(keys: readonly string[], selected: string | null, closed: string) {
  if (closed !== selected) return selected;
  const index = keys.indexOf(closed);
  return keys[index + 1] ?? keys[index - 1] ?? null;
}
export const artifactStore = createArtifactStore();
export const artifactOwner = (section: string, card: string) => JSON.stringify([section, card]);

const nativeOwnerSchema = z.object({ section: z.string().min(1).max(1000), card: z.string().min(1).max(1000) }).strict();
export type NativeArtifactOwner = z.infer<typeof nativeOwnerSchema>;
const savedOwnersSchema = z.array(z.tuple([z.string().min(1).max(16000), nativeOwnerSchema])).max(500);

/** Window-session bookkeeping, not identities used to reopen tabs. An owner is
 * looked up only for keys BB currently reports live. Remounting the panel or
 * replacing its card must never assign an already-open tab to the new card. */
export function createNativeArtifactOwners(storage: () => Storage = () => window.sessionStorage) {
  const storageKey = 'thread-kanban:native-artifact-owners:v1';
  const owners = new Map<string, NativeArtifactOwner>();
  let loaded = false;
  function load() {
    if (loaded) return;
    loaded = true;
    try { for (const [key, owner] of savedOwnersSchema.parse(JSON.parse(storage().getItem(storageKey) ?? '[]'))) owners.set(key, owner); }
    catch { /* Malformed/unavailable storage leaves a usable in-memory registry. */ }
  }
  function save() {
    while (owners.size > 500) owners.delete(owners.keys().next().value!);
    try { storage().setItem(storageKey, JSON.stringify([...owners])); } catch { /* Preserve the live in-memory owner. */ }
  }
  return {
    get(key: string) { load(); return owners.get(key); },
    has(key: string) { load(); return owners.has(key); },
    set(key: string, owner: NativeArtifactOwner) {
      load();
      if (owners.has(key)) return;
      owners.set(key, owner); save();
    },
    delete(key: string) { load(); if (owners.delete(key)) save(); },
    retain(keys: ReadonlySet<string>) { load(); for (const key of owners.keys()) if (!keys.has(key)) owners.delete(key); save(); },
  };
}
export const nativeArtifactOwners = createNativeArtifactOwners();
