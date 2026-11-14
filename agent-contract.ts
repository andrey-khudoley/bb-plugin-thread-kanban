import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { snapshotInput, cardInput, uiInput, openInput, captureInput } from "./agent-inputs.mjs";
export { snapshotInput, cardInput, uiInput, openInput, captureInput, agentToolNames } from "./agent-inputs.mjs";

const id = z.string().min(1).max(160);
export const agentChannel = "kanban-agent-observer-request";
export const uiReport = z.object({
  windowId: id, observerId: z.string().uuid().nullable(), requestId: z.string().uuid().nullable(),
  capturedAt: z.number().int(), generation: z.number().int().nonnegative(), pluginId: id,
  route: z.string().max(1000), documentVisible: z.boolean(), mounted: z.boolean(),
  viewport: z.object({ width: z.number(), height: z.number(), devicePixelRatio: z.number() }).strict(),
  state: z.json().refine((value) => JSON.stringify(value).length <= 64000, "UI state exceeds 64 KB"),
  cards: z.array(z.object({ id, kind: z.string().max(30), projectId: z.string().max(160),
    stage: z.string().max(30), title: z.string().max(300), inViewport: z.boolean(), chatOpen: z.boolean().default(false),
    chatActive: z.boolean().default(false), cardActive: z.boolean().default(false),
    x: z.number(), y: z.number(), width: z.number(), height: z.number() }).strict()).max(500),
  controls: z.array(z.object({ role: z.string().max(30), name: z.string().max(200), disabled: z.boolean(),
    expanded: z.string().max(10).nullable(), selected: z.string().max(10).nullable() }).strict()).max(300),
  overlays: z.array(z.object({ role: z.string().max(30), text: z.string().max(3000) }).strict()).max(12),
  panels: z.array(z.object({ kind: z.string().max(30), id: z.string().max(160), tab: z.string().max(100) }).strict()).max(20),
  errors: z.array(z.string().max(2000)).max(20), truncated: z.boolean(),
}).strict();
export type UiReport = z.infer<typeof uiReport>;

export const agentRpc = defineRpcContract({
  agentSnapshot: { input: snapshotInput, output: z.json(), experimental_description: "Read bounded server board data. Does not claim UI visibility." },
  agentCardGet: { input: cardInput, output: z.json(), experimental_description: "Read a task or native chat and its links." },
  agentDiagnostics: { input: z.object({}).strict(), output: z.json(), experimental_description: "Read installed build, deployment and observer health." },
  agentUiSnapshot: { input: uiInput, output: z.json(), experimental_description: "Request a fresh report from mounted BB windows." },
  agentUiReport: { input: uiReport, output: z.null() },
  agentUiGone: { input: z.object({ windowId: id }).strict(), output: z.null() },
  agentUiOpen: { input: openInput, output: z.json(), experimental_description: "Open an owned BB browser tab on the real Kanban." },
  agentUiCapture: { input: captureInput, output: z.json(), experimental_description: "Capture the owned real BB browser tab as JPEG." },
  agentUiClose: { input: captureInput, output: z.json(), experimental_description: "Close only a Kanban observer tab created by this plugin." },
});
