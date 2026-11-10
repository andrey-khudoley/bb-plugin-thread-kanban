import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createKanbanMcp } from "./mcp.mjs";

async function connect(t, call) {
  const server = createKanbanMcp({ call, env: { BB_THREAD_ID: "thr_mcp_test" } });
  const client = new Client({ name: "kanban-tests", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test("MCP negotiates, lists all seven tools and forwards validated arguments to the same RPC", async (t) => {
  const calls = [];
  const client = await connect(t, async (method, input) => { calls.push({ method, input }); return { status: "ok", total: 3 }; });
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 7);
  assert.equal(tools.tools.find((tool) => tool.name === "kanban_snapshot").annotations.readOnlyHint, true);
  const result = await client.callTool({ name: "kanban_snapshot", arguments: { limit: 10, includeArchived: true } });
  assert.equal(JSON.parse(result.content[0].text).total, 3);
  assert.equal(calls[0].method, "agentSnapshot"); assert.equal(calls[0].input.limit, 10);
  const invalid = await client.callTool({ name: "kanban_snapshot", arguments: { limit: 201 } });
  assert.equal(invalid.isError, true); assert.equal(calls.length, 1);
  await client.callTool({ name: "kanban_ui_open", arguments: { hostId: "host_test", instanceId: "desktop_test" } });
  assert.equal(calls.at(-1).input.threadId, "thr_mcp_test");
});

test("MCP returns screenshots as image content and reports RPC errors", async (t) => {
  const client = await connect(t, async (method) => {
    if (method !== "agentUiCapture") throw new Error("No live board");
    return { base64: "/9j/test", mimeType: "image/jpeg", width: 1200, height: 800, source: "desktop-browser-screenshot" };
  });
  const image = await client.callTool({ name: "kanban_ui_capture", arguments: { windowId: "window-test" } });
  assert.equal(image.content[1].type, "image"); assert.equal(image.content[1].data, "/9j/test");
  assert.equal("base64" in JSON.parse(image.content[0].text), false);
  const failure = await client.callTool({ name: "kanban_ui_snapshot", arguments: {} });
  assert.equal(failure.isError, true); assert.match(failure.content[0].text, /No live board/);
});
