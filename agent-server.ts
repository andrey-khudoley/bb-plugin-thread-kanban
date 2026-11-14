import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { experimental_PluginRpcRefusal, type BbPluginApi, type PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { agentChannel, agentRpc, agentToolNames, cardInput, captureInput, openInput, snapshotInput, uiInput, type UiReport } from "./agent-contract";
import { stageOf } from "./board";
import { issueStages, type Issue } from "./issues";
import { emptyPlan, planSchema } from "./planning";
import { toolDefinitions } from "./agent-inputs.mjs";
import type { ProjectFolders } from './project-folders-server';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2000);
const json = (value: unknown): z.infer<ReturnType<typeof z.json>> => JSON.parse(JSON.stringify(value));
const refusal = (text: string) => new experimental_PluginRpcRefusal({ code: "not_found", message: text });
type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
type Tab = { hostId: string; instanceId: string; generation: string; threadId: string; tabId: string; observerId: string; createdAt: number; windowId?: string };
const tabSchema = z.object({ hostId: z.string(), instanceId: z.string(), generation: z.string(), threadId: z.string(),
  tabId: z.string(), observerId: z.string().uuid(), createdAt: z.number(), windowId: z.string().optional() }).strict();
const tabPrefix = "agent-observer-tabs/v1/";
const target = ({ hostId, instanceId, generation, threadId, tabId }: Tab) => ({ hostId, instanceId, generation, threadId, tabId });

export function threadSummary(thread: Thread) {
  const nativeStage = stageOf({ isArchived: thread.archivedAt !== null, hasPendingInteraction: thread.hasPendingInteraction,
    runtimeStatus: thread.runtime.displayStatus, queuedWork: thread.queuedWork, status: thread.status,
    activity: { workflows: thread.activity.activeWorkflowCount, backgroundAgents: thread.activity.activeBackgroundAgentCount,
      backgroundCommands: thread.activity.activeBackgroundCommandCount, planMode: thread.activity.activePlanModeCount } });
  return { id: thread.id, kind: "thread", projectId: thread.projectId, title: thread.title ?? thread.titleFallback ?? thread.id,
    stage: nativeStage === "new" ? "backlog" : nativeStage === "waiting" ? "working" : nativeStage,
    nativeStage, status: thread.status, runtimeStatus: thread.runtime.displayStatus, queuedWork: thread.queuedWork,
    hasPendingInteraction: thread.hasPendingInteraction, parentId: thread.parentThreadId,
    archived: thread.archivedAt !== null, hidden: thread.visibility === "hidden", environmentId: thread.environmentId,
    updatedAt: thread.updatedAt, error: thread.status === "error" || thread.queuedWork === "failed" };
}

export function registerAgentAccess(bb: BbPluginApi, issues: { list(): Issue[]; get(id: string): Issue }, folders?: ProjectFolders) {
  const windows = new Map<string, { report: UiReport; receivedAt: number }>();
  const waiters = new Map<string, (report: UiReport) => void>();
  const lifetime = new AbortController();
  const owned = new Map<string, Tab>();
  const desktop = () => bb.sdk.experimental_desktopBrowsers;
  const recent = () => [...windows.values()].filter((entry) => Date.now() - entry.receivedAt < 15000);

  async function fresh(input: z.infer<typeof uiInput>, signal?: AbortSignal) {
    const requestId = randomUUID();
    const reports = new Map<string, UiReport>();
    const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    return await new Promise<{ reports: UiReport[]; requestId: string }>((resolve, reject) => {
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => { cleanup(); resolve({ reports: [...reports.values()], requestId }); };
      const abort = () => { cleanup(); reject(combined.reason); };
      const timer = setTimeout(finish, input.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer); clearTimeout(settleTimer); waiters.delete(requestId); combined.removeEventListener("abort", abort);
      };
      waiters.set(requestId, (report) => {
        if (input.windowId && report.windowId !== input.windowId) return;
        reports.set(report.windowId, report);
        if (!settleTimer) settleTimer = setTimeout(finish, input.windowId ? 0 : 200);
      });
      combined.addEventListener("abort", abort, { once: true });
      try { bb.realtime.publish(agentChannel, { requestId, windowId: input.windowId ?? null }); }
      catch (error) { cleanup(); reject(error); }
    });
  }
  async function uiSnapshot(input: z.infer<typeof uiInput>, signal?: AbortSignal) {
    const { reports, requestId } = await fresh(input, signal);
    reports.sort((a, b) => Number(b.mounted) - Number(a.mounted) || Number(b.documentVisible) - Number(a.documentVisible));
    return json({ source: "mounted-ui", requestId, capturedAt: Date.now(),
      status: reports.some((report) => report.mounted) ? "ok" : reports.length ? "board_closed" : "no_window",
      windows: reports.slice(0, 4), windowsTotal: reports.length, truncated: reports.length > 4,
      knownWindows: recent().map(({ report, receivedAt }) => ({ windowId: report.windowId,
        mounted: report.mounted, documentVisible: report.documentVisible, lastSeenAt: receivedAt })) });
  }
  async function snapshot(input: z.infer<typeof snapshotInput>, signal?: AbortSignal) {
    const [projects, active, archived] = await Promise.all([
      bb.sdk.projects.list({ includePersonal: true, signal }), scanThreads(false, input, signal),
      input.includeArchived ? scanThreads(true, input, signal) : Promise.resolve({ rows: [] as Thread[], truncated: false }),
    ]);
    const threads = [...active.rows, ...archived.rows];
    const allIssues = issues.list();
    const claimed = new Set(allIssues.flatMap((issue) => issue.threadIds));
    const nativeThreads = threads.filter((thread) => !claimed.has(thread.id));
    const plans = new Map<string, z.infer<typeof planSchema>>();
    for (let index = 0; index < nativeThreads.length; index += 200) {
      const rows = await bb.sdk.threads.experimental_listPluginMetadata({ threadIds: nativeThreads.slice(index, index + 200).map(({ id }) => id), signal });
      rows.threads.forEach((row) => plans.set(row.threadId, planSchema.safeParse(row.metadata).data ?? emptyPlan));
    }
    const search = new Map(allIssues.map((issue) => [issue.id,
      [issue.title, issue.description, issue.notes, issue.assignee, ...issue.tags].join(" ").toLocaleLowerCase("ru")]));
    for (const thread of nativeThreads) {
      const plan = plans.get(thread.id) ?? emptyPlan;
      search.set(thread.id, [thread.title, thread.titleFallback, plan.notes, ...plan.tags].join(" ").toLocaleLowerCase("ru"));
    }
    const archivedIds = new Set(archived.rows.map((thread) => thread.id));
    // Linked archived chats can be absent from the active sidebar even when archive is hidden.
    if (!input.includeArchived) {
      const linked = [...claimed];
      for (let index = 0; index < linked.length; index += 200) {
        const rows = await bb.sdk.threads.list({ threadIds: linked.slice(index, index + 200), archived: true, includeHidden: true, limit: 200, signal });
        rows.forEach((thread) => archivedIds.add(thread.id));
      }
    }
    const cards = [
      ...allIssues.filter((issue) => (input.includeArchived || !issue.threadIds.length || !issue.threadIds.every((id) => archivedIds.has(id))))
        .map((issue) => ({ id: issue.id, kind: "issue", projectId: issue.projectId, title: issue.title || "Новая задача",
          stage: issue.status, parentId: issue.parentId, blockedBy: issue.blockedBy, related: issue.related,
          duplicateOf: issue.duplicateOf, tags: issue.tags, priority: issue.priority, assignee: issue.assignee,
          threadIds: issue.threadIds.slice(0, 100), threadIdsTotal: issue.threadIds.length,
          busy: issue.busy, error: issue.error?.slice(0, 2000) ?? null, version: issue.version, updatedAt: issue.updatedAt })),
      ...nativeThreads.map((thread) => ({ ...threadSummary(thread),
        tags: (plans.get(thread.id) ?? emptyPlan).tags, priority: (plans.get(thread.id) ?? emptyPlan).priority })),
    ].filter((card) => (!input.projectId || card.projectId === input.projectId) && (!input.stage || card.stage === input.stage) &&
      (search.get(card.id) ?? "").includes(input.query.toLocaleLowerCase("ru")))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const counts = issueStages.map((stage) => ({ ...stage, count: cards.filter((card) => card.stage === stage.id).length }));
    return json({ source: "server", capturedAt: Date.now(), filters: input,
      sections: projects.filter((project) => !input.projectId || project.id === input.projectId).map(({ id, name }) => ({ id, name })),
      projectFolders: folders?.list().filter((folder) => !input.projectId || folder.sectionId === input.projectId).map(({ messages, assistant, ...folder }) => folder) ?? [],
      projects: projects.filter((project) => !input.projectId || project.id === input.projectId).map(({ id, name }) => ({ id, name })),
      columns: counts, total: cards.length, cards: cards.slice(input.offset, input.offset + input.limit),
      nextOffset: input.offset + input.limit < cards.length ? input.offset + input.limit : null,
      truncated: active.truncated || archived.truncated,
      note: "Server data; current browser filters and actual visibility are available through kanban_ui_snapshot." });
  }
  async function scanThreads(archived: boolean, input: z.infer<typeof snapshotInput>, signal?: AbortSignal) {
    const rows: Thread[] = [];
    for (let offset = 0; offset < 5000; offset += 200) {
      const page = await bb.sdk.threads.list({ archived, projectId: input.projectId, includeHidden: input.includeHidden, offset, limit: 200, signal });
      rows.push(...page);
      if (page.length < 200) return { rows, truncated: false };
    }
    return { rows, truncated: true };
  }
  async function cardGet(input: z.infer<typeof cardInput>, signal?: AbortSignal) {
    if (input.kind === "thread") {
      const thread = await readThread(input.id, signal);
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: input.id, signal });
      return json({ source: "server", capturedAt: Date.now(), ...threadSummary(thread),
        plan: planSchema.safeParse(metadata).data ?? emptyPlan,
        linkedIssues: issues.list().filter((issue) => issue.threadIds.includes(input.id)).map(({ id, title, status }) => ({ id, title, status })) });
    }
    let issue: Issue;
    try { issue = issues.get(input.id); } catch { throw refusal("Карточка не найдена."); }
    const runs = await Promise.all(issue.threadIds.slice(0, 100).map(async (threadId) => {
      try { return threadSummary(await readThread(threadId, signal)); }
      catch (error) { signal?.throwIfAborted(); return { id: threadId, unavailable: true, error: message(error) }; }
    }));
    const end = Math.max(0, issue.messages.length - input.messageOffset);
    const start = Math.max(0, end - input.messageLimit);
    const children = issues.list().filter((item) => item.parentId === issue.id);
    return json({ source: "server", capturedAt: Date.now(),
      issue: { ...issue, messages: issue.messages.slice(start, end), threadIds: issue.threadIds.slice(0, 100), error: issue.error?.slice(0, 2000) ?? null }, runs,
      messagesTotal: issue.messages.length, nextMessageOffset: start > 0 ? input.messageOffset + input.messageLimit : null,
      children: children.slice(0, 200).map(({ id, title, status }) => ({ id, title, status })), childrenTotal: children.length,
      threadIdsTotal: issue.threadIds.length, runsTruncated: issue.threadIds.length > 100 });
  }
  async function readThread(threadId: string, signal?: AbortSignal) {
    const details = await bb.sdk.threads.get({ threadId, signal });
    const [thread] = await bb.sdk.threads.list({ threadIds: [threadId], includeHidden: true,
      archived: details.archivedAt !== null, limit: 1, signal });
    if (!thread) throw refusal("Чат больше не доступен.");
    return thread;
  }
  async function diagnostics() {
    const inventory = await bb.sdk.plugins.list();
    const plugin = inventory.plugins.find((entry) => entry.id === bb.pluginId);
    if (!plugin) throw refusal("Плагин отсутствует в текущем списке BB.");
    const deployment = await readFile(join(plugin.rootDir, ".bb-deployment.json"), "utf8")
      .then((text) => { const record = JSON.parse(text); return { revision: record.revision, tree: record.tree, builtAt: record.builtAt }; })
      .catch(() => null);
    const deploy = inventory.plugins.some((entry) => entry.id === "workspace-deploy" && entry.status === "running")
      ? await bb.sdk.plugins.callRpc({ pluginId: "workspace-deploy", method: "deploymentStatus", input: null, outputSchema: z.json() })
        .catch((error) => ({ unavailable: true, error: message(error) })) : null;
    return json({ source: "server", capturedAt: Date.now(), plugin: { id: plugin.id, version: plugin.version,
      status: plugin.status, statusDetail: plugin.statusDetail, rootDir: plugin.rootDir, app: plugin.app, deployment },
      deploy, boardUrl: new URL(`/plugins/${bb.pluginId}/board`, bb.server.loopbackBaseUrl).href,
      windows: recent().map(({ report, receivedAt }) => ({ windowId: report.windowId, mounted: report.mounted,
        generation: report.generation, lastSeenAt: receivedAt, route: report.route, errors: report.errors })),
      tools: agentToolNames, capture: { backend: "BB desktop captureTab", requires: "An owned observer tab; use kanban_ui_open with an explicit host and instance." } });
  }
  async function loadTabs() {
    for (const key of await bb.storage.kv.list(tabPrefix)) {
      const parsed = tabSchema.safeParse(await bb.storage.kv.get(key));
      if (parsed.success) owned.set(parsed.data.observerId, parsed.data);
    }
  }
  let tabsReady: Promise<void> | undefined;
  const ensureTabs = () => tabsReady ??= loadTabs();
  async function closeTab(tab: Tab) {
    await desktop().closeTab(target(tab));
    owned.delete(tab.observerId);
    await bb.storage.kv.delete(tabPrefix + tab.observerId);
    for (const [id, entry] of windows) if (entry.report.observerId === tab.observerId) windows.delete(id);
  }
  async function uiOpen(input: z.infer<typeof openInput>, signal?: AbortSignal) {
    if (!input.threadId) throw new Error("Укажи threadId для вкладки наблюдения.");
    await ensureTabs();
    const { instances } = await desktop().listInstances({ hostId: input.hostId });
    const instance = instances.find((entry) => entry.instanceId === input.instanceId);
    if (!instance) throw refusal("Выбранное окно BB недоступно. Выполни bb browser instances --host <hostId> --json.");
    if (owned.size >= 8) throw new Error("Открыто 8 вкладок наблюдения. Закрой ненужную через kanban_ui_close.");
    const observerId = randomUUID();
    const scope = { hostId: input.hostId, instanceId: instance.instanceId, generation: instance.generation, threadId: input.threadId };
    // The configured app URL works on remote desktops; loopback is only meaningful on the server's host.
    const appUrl = bb.server.experimental_appUrl ?? bb.server.loopbackBaseUrl;
    const url = new URL(`/plugins/${bb.pluginId}/board`, appUrl);
    url.searchParams.set("kanban-observer", observerId);
    const created = await desktop().createTab({ ...scope, url: url.href, presentation: "reveal" });
    const tab: Tab = { ...scope, tabId: created.tab.tabId, observerId, createdAt: Date.now() };
    owned.set(observerId, tab);
    await bb.storage.kv.set(tabPrefix + observerId, tab);
    try {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const { reports } = await fresh({ timeoutMs: 1000 }, signal);
        const report = reports.find((entry) => entry.observerId === observerId && entry.mounted &&
          Array.isArray(entry.state) && entry.state.some((state) => state && typeof state === "object" &&
            !Array.isArray(state) && state.loading === false));
        if (report) {
          tab.windowId = report.windowId;
          await bb.storage.kv.set(tabPrefix + observerId, tab);
          return json({ status: "ok", source: "mounted-ui", windowId: report.windowId, observerId,
            hostId: tab.hostId, instanceId: tab.instanceId, tabId: tab.tabId, threadId: tab.threadId, snapshot: report });
        }
      }
      throw new Error("Вкладка BB открылась, но канбан не ответил за 12 секунд. Проверь доступ к BB и установленную сборку.");
    } catch (error) { await closeTab(tab).catch(() => {}); throw error; }
  }
  async function ownedWindow(input: z.infer<typeof captureInput>, signal?: AbortSignal) {
    await ensureTabs();
    const { reports } = await fresh({ windowId: input.windowId, timeoutMs: 3000 }, signal);
    const report = reports[0];
    if (!report?.observerId) throw refusal("Открытая вкладка наблюдения не найдена. Вызови kanban_ui_open.");
    const tab = owned.get(report.observerId);
    if (!tab || (input.threadId && tab.threadId !== input.threadId)) throw refusal("Вкладка не принадлежит этому чату.");
    return { tab, report };
  }
  async function uiCapture(input: z.infer<typeof captureInput>, signal?: AbortSignal) {
    const { tab, report } = await ownedWindow(input, signal);
    if (!report.mounted) throw refusal("Канбан в этой вкладке закрыт. Открой канбан перед захватом изображения.");
    signal?.throwIfAborted();
    const image = await desktop().captureTab(target(tab));
    if (image.base64.length > 4000000) throw new Error("Скриншот превышает допустимый размер 3 МБ.");
    return json({ status: "ok", source: "desktop-browser-screenshot", capturedAt: Date.now(), windowId: report.windowId,
      snapshotCapturedAt: report.capturedAt, hostId: tab.hostId, tabId: tab.tabId, ...image });
  }
  async function uiClose(input: z.infer<typeof captureInput>, signal?: AbortSignal) {
    // Use the stored identity so cleanup works even after navigation or loss of the frontend heartbeat.
    await ensureTabs();
    const known = [...owned.values()].find((tab) => tab.windowId === input.windowId);
    const tab = known ?? (await ownedWindow(input, signal)).tab;
    if (input.threadId && tab.threadId !== input.threadId) throw refusal("Вкладка не принадлежит этому чату.");
    await closeTab(tab);
    return json({ closed: true, windowId: input.windowId });
  }

  bb.rpc.register(agentRpc, {
    agentSnapshot: (input, ctx) => snapshot(input, ctx.experimental_signal),
    agentCardGet: (input, ctx) => cardGet(input, ctx.experimental_signal),
    agentDiagnostics: () => diagnostics(),
    agentUiSnapshot: (input, ctx) => uiSnapshot(input, ctx.experimental_signal),
    agentUiReport(report) {
      if (report.pluginId !== bb.pluginId) throw new Error("Неверный pluginId наблюдателя.");
      if (!windows.has(report.windowId) && windows.size >= 64) {
        const oldest = [...windows].sort((a, b) => a[1].receivedAt - b[1].receivedAt)[0];
        if (oldest) windows.delete(oldest[0]);
      }
      windows.set(report.windowId, { report, receivedAt: Date.now() });
      if (report.requestId) waiters.get(report.requestId)?.(report);
      return null;
    },
    agentUiGone({ windowId }) { windows.delete(windowId); return null; },
    agentUiOpen: (input, ctx) => uiOpen(input, ctx.experimental_signal),
    agentUiCapture: (input, ctx) => uiCapture(input, ctx.experimental_signal),
    agentUiClose: (input, ctx) => uiClose(input, ctx.experimental_signal),
  }, { experimental_discoverable: true, experimental_description: "Kanban agent inspection and real UI observer v1" });

  function registerTool<Schema extends z.ZodType>(index: number, parameters: Schema,
    run: (input: z.output<Schema>, signal?: AbortSignal) => Promise<z.infer<ReturnType<typeof z.json>>>,
    options: { scopeThread?: boolean; image?: boolean } = {}) {
    const descriptor = toolDefinitions[index];
    bb.agents.registerTool({ name: descriptor.name, description: descriptor.description, parameters,
      async execute(input, ctx): Promise<PluginAgentToolResult> {
        try {
          const scoped = options.scopeThread ? parameters.parse({ ...(input as object), threadId: ctx.threadId }) : input;
          const result = await run(scoped, ctx.signal);
          if (options.image) {
            const { base64, ...metadata } = result as { [key: string]: z.infer<ReturnType<typeof z.json>> };
            return { content: [{ type: "text", text: JSON.stringify(metadata) }, { type: "image", data: String(base64), mimeType: "image/jpeg" }] };
          }
          return JSON.stringify(result);
        } catch (error) { return { content: [{ type: "text", text: message(error) }], isError: true }; }
      },
    });
  }
  registerTool(0, snapshotInput, snapshot);
  registerTool(1, cardInput, cardGet);
  registerTool(2, toolDefinitions[2].parameters, diagnostics);
  registerTool(3, uiInput, uiSnapshot);
  registerTool(4, openInput, uiOpen, { scopeThread: true });
  registerTool(5, captureInput, uiCapture, { scopeThread: true, image: true });
  registerTool(6, captureInput, uiClose, { scopeThread: true });
  const cleanupTimer = setInterval(() => {
    for (const [id, entry] of windows) if (Date.now() - entry.receivedAt > 60000) windows.delete(id);
    void ensureTabs().then(() => {
      for (const tab of owned.values()) if (Date.now() - tab.createdAt > 30 * 60000) void closeTab(tab).catch(() => {});
    }).catch(() => {});
  }, 60000);
  cleanupTimer.unref();
  for (const event of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, async ({ thread }) => {
      if (tabsReady) await tabsReady;
      await Promise.allSettled([...owned.values()].filter((tab) => tab.threadId === thread.id).map(closeTab));
    });
  }
  bb.onDispose(async () => {
    lifetime.abort(); clearInterval(cleanupTimer); windows.clear();
    if (tabsReady) await tabsReady.catch(() => {});
    await Promise.allSettled([...owned.values()].map(closeTab));
  });
  return [...agentToolNames];
}
