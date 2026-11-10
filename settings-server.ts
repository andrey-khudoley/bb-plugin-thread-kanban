import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  changed, contract, defaultPaneHeaders, paneHeaders, preferenceSchema, settingsSchema,
  windowPlacement, windowPlacementChanged, windowPlacementContract, type Settings,
} from "./settings-contract";

const key = "kanban-settings-v1";
const stores = new WeakMap<BbPluginApi, ReturnType<typeof createStore>>();

function createStore(bb: BbPluginApi) {
  let initializing: Promise<Settings> | null = null;
  let writing: Promise<unknown> = Promise.resolve();
  async function migrate(): Promise<Settings> {
    const inventory = await bb.sdk.plugins.list();
    const legacy = inventory.plugins.find(({ id }) => id === "chat-defaults");
    let value: Settings = { preference: null, windowPlacement: "right", paneHeaders: { ...defaultPaneHeaders } };
    if (legacy) {
      if (legacy.status !== "running") {
        throw new Error("Включи старый плагин chat-defaults для переноса настроек канбана. После переноса его можно отключить.");
      }
      const [preference, placement, headers] = await Promise.all([
        bb.sdk.plugins.callRpc({ pluginId: legacy.id, method: "read", input: null, outputSchema: preferenceSchema.nullable() }),
        bb.sdk.plugins.callRpc({ pluginId: legacy.id, method: "readWindowPlacement", input: null, outputSchema: windowPlacement }),
        bb.sdk.plugins.callRpc({ pluginId: legacy.id, method: "readPaneHeaders", input: null, outputSchema: paneHeaders }),
      ]);
      value = settingsSchema.parse({ preference, windowPlacement: placement, paneHeaders: headers });
    }
    // One atomic write: a failed legacy read never replaces saved preferences with defaults.
    await bb.storage.kv.set(key, value);
    return value;
  }
  async function read(): Promise<Settings> {
    const saved = await bb.storage.kv.get(key);
    if (saved !== undefined && saved !== null) return settingsSchema.parse(saved);
    if (!initializing) initializing = migrate().finally(() => { initializing = null; });
    return initializing;
  }
  function update(patch: Partial<Settings>) {
    const result = writing.then(async () => {
      const value = settingsSchema.parse({ ...await read(), ...patch });
      await bb.storage.kv.set(key, value);
      return value;
    });
    writing = result.catch(() => {});
    return result;
  }
  return { read, update };
}

export function settingsStore(bb: BbPluginApi) {
  let store = stores.get(bb);
  if (!store) { store = createStore(bb); stores.set(bb, store); }
  return store;
}

export function registerSettings(bb: BbPluginApi) {
  const store = settingsStore(bb);
  bb.rpc.register(contract, {
    async read() { return (await store.read()).preference; },
    async save(preference) {
      const value = await store.update({ preference });
      bb.realtime.publish(changed, {});
      return value.preference;
    },
  }, { experimental_discoverable: true, experimental_description: "Kanban execution defaults; null inherits BB defaults" });
  bb.rpc.register(windowPlacementContract, {
    async readWindowPlacement() { return (await store.read()).windowPlacement; },
    async readPaneHeaders() { return (await store.read()).paneHeaders; },
    async saveWindowPlacement(windowPlacement) {
      const value = await store.update({ windowPlacement });
      bb.realtime.publish(windowPlacementChanged, {});
      return value.windowPlacement;
    },
    async savePaneHeaders(paneHeaders) {
      const value = await store.update({ paneHeaders });
      bb.realtime.publish(windowPlacementChanged, {});
      return value.paneHeaders;
    },
  }, { experimental_discoverable: true, experimental_description: "Kanban panel placement and headers" });
}
