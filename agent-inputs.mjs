import { z } from "zod";

const id = z.string().min(1).max(160);
export const snapshotInput = z.object({
  projectId: id.optional(), includeArchived: z.boolean().default(false), includeHidden: z.boolean().default(false),
  query: z.string().max(200).default(""), stage: z.string().max(30).optional(),
  limit: z.number().int().min(1).max(200).default(100), offset: z.number().int().min(0).max(10000).default(0),
}).strict();
export const cardInput = z.object({ id, kind: z.enum(["issue", "thread"]).default("issue"),
  messageOffset: z.number().int().min(0).max(100000).default(0), messageLimit: z.number().int().min(1).max(50).default(20),
}).strict();
export const uiInput = z.object({ windowId: id.optional(), timeoutMs: z.number().int().min(250).max(10000).default(3000) }).strict();
export const openInput = z.object({ hostId: id, instanceId: id, threadId: id.optional() }).strict();
export const captureInput = z.object({ windowId: id, threadId: id.optional() }).strict();
export const toolDefinitions = [
  { name: "kanban_snapshot", method: "agentSnapshot", parameters: snapshotInput, readOnly: true,
    description: "Read server board data: projects, stages, cards, hierarchy, dependencies and runs. Use kanban_ui_snapshot for actual UI visibility." },
  { name: "kanban_card_get", method: "agentCardGet", parameters: cardInput, readOnly: true,
    description: "Read one issue or native thread, its plan, child cards, runs and errors." },
  { name: "kanban_diagnostics", method: "agentDiagnostics", parameters: z.object({}).strict(), readOnly: true,
    description: "Read the installed build, frontend hash, deployment status and live observer health." },
  { name: "kanban_ui_snapshot", method: "agentUiSnapshot", parameters: uiInput, readOnly: true,
    description: "Request a fresh report from actual mounted BB windows: filters, cards, controls, panels and errors. No open board yields board_closed/no_window." },
  { name: "kanban_ui_open", method: "agentUiOpen", parameters: openInput, readOnly: false,
    description: "Open the real Kanban in an owned BB browser tab. Specify hostId and instanceId from bb browser instances; threadId is required outside a BB thread." },
  { name: "kanban_ui_capture", method: "agentUiCapture", parameters: captureInput, readOnly: true,
    description: "Return an actual JPEG screenshot of the observer window from kanban_ui_open. Uses BB desktop captureTab and works on Windows." },
  { name: "kanban_ui_close", method: "agentUiClose", parameters: captureInput, readOnly: false,
    description: "Close only a Kanban observer tab created by kanban_ui_open after verification." },
];
export const agentToolNames = toolDefinitions.map(({ name }) => name);
