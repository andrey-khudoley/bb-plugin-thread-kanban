import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { callBb } from "../mcp.mjs";

const [hostId, instanceId, outputDirectory] = process.argv.slice(2);
if (!hostId || !instanceId || !outputDirectory) throw new Error("Usage: node scripts/smoke-agent.mjs <hostId> <instanceId> <output-directory>");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const client = new Client({ name: "kanban-live-smoke", version: "1.0.0" });
const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(root, "mcp.mjs")], env, stderr: "pipe" });
const evidence = { startedAt: new Date().toISOString(), pluginId: process.env.KANBAN_PLUGIN_ID || "thread-kanban" };
let windowId;
const fixtures = [];
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content[0]?.text ?? "MCP tool failed");
  return result;
}
try {
  await client.connect(transport);
  if (process.env.KANBAN_SMOKE_FIXTURE === "1") {
    assert.match(evidence.pluginId, /-qa$/, "Fixtures are allowed only in a separate QA plugin");
    for (let index = 0; index < 2; index++) {
      const issue = await callBb("issueCreate", { projectId: "proj_personal", status: "todo", test: true });
      fixtures.push(issue.id);
      await callBb("issueSave", { id: issue.id, version: issue.version, fields: { ...issue,
        title: `Test · MCP observer ${index + 1}`, autoTitle: false, autoPlan: false,
        ...(index ? { parentId: fixtures[0], blockedBy: [fixtures[0]] } : {}),
      } });
    }
    evidence.fixtures = fixtures;
  }
  evidence.tools = (await client.listTools()).tools.map(({ name }) => name);
  assert.equal(evidence.tools.length, 7);
  evidence.snapshot = JSON.parse((await call("kanban_snapshot", { limit: 5 })).content[0].text);
  const first = evidence.snapshot.cards[0];
  if (first) evidence.card = JSON.parse((await call("kanban_card_get", { id: first.id, kind: first.kind })).content[0].text);
  evidence.diagnostics = JSON.parse((await call("kanban_diagnostics")).content[0].text);
  evidence.before = JSON.parse((await call("kanban_ui_snapshot", { timeoutMs: 1000 })).content[0].text);
  const opened = JSON.parse((await call("kanban_ui_open", { hostId, instanceId })).content[0].text);
  windowId = opened.windowId;
  assert.equal(opened.status, "ok");
  evidence.opened = opened;
  evidence.ui = JSON.parse((await call("kanban_ui_snapshot", { windowId })).content[0].text);
  assert.equal(evidence.ui.status, "ok");
  assert.ok(evidence.ui.windows[0].state.some((state) => state.loading === false));
  assert.deepEqual(evidence.ui.windows[0].errors, []);
  for (const id of fixtures) assert.ok(evidence.ui.windows[0].cards.some((card) => card.id === id), "The QA task must actually render");
  const image = await call("kanban_ui_capture", { windowId });
  evidence.image = JSON.parse(image.content[0].text);
  assert.equal(image.content[1].type, "image");
  const bytes = Buffer.from(image.content[1].data, "base64");
  assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, "kanban-agent-capture.jpg"), bytes);
  console.log(JSON.stringify({ status: "ok", tools: evidence.tools, windowId, cardCount: evidence.ui.windows[0].cards.length,
    viewport: evidence.ui.windows[0].viewport, image: evidence.image, screenshotBytes: bytes.length }));
} finally {
  if (windowId) evidence.closed = JSON.parse((await call("kanban_ui_close", { windowId })).content[0].text);
  await client.close();
  for (const id of fixtures.reverse()) {
    const { issue } = await callBb("agentCardGet", { id });
    assert.ok(issue.tags.includes("Test") && issue.threadIds.length === 0);
    const preview = await callBb("issueDeletePreview", { id });
    await callBb("issueDelete", { id, confirmation: preview.confirmation });
  }
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, "kanban-agent-evidence.json"), JSON.stringify(evidence, null, 2));
}
