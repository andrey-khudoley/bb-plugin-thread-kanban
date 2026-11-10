#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toolDefinitions } from "./agent-inputs.mjs";

const exec = promisify(execFile);

/** Use the JS BB entrypoint directly on Windows, without cmd.exe or shell interpolation. */
export async function resolveCli(env = process.env) {
  const explicit = env.KANBAN_BB_CLI || env.BB_CLI;
  const candidates = explicit ? [explicit] : (env.PATH ?? "").split(delimiter).filter(Boolean)
    .flatMap((directory) => [join(directory, "bb"), join(directory, "bb.exe")]);
  for (const candidate of candidates) {
    try {
      const path = resolve(candidate);
      const first = (await readFile(path)).subarray(0, 80).toString("utf8");
      if (first.startsWith("#!") && first.includes("node")) return { command: process.execPath, prefix: [path] };
      if (process.platform !== "win32" || /\.exe$/i.test(path)) return { command: path, prefix: [] };
    } catch { /* Try the next actual entrypoint. */ }
  }
  throw new Error("BB CLI not found. Set KANBAN_BB_CLI to the absolute BB executable or its Node entrypoint (the bb file beside bb.cmd).");
}

export async function callBb(method, input, { env = process.env, signal } = {}) {
  const cli = await resolveCli(env);
  const pluginId = env.KANBAN_PLUGIN_ID || "thread-kanban";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(pluginId)) throw new Error("Invalid KANBAN_PLUGIN_ID");
  const folder = await mkdtemp(join(tmpdir(), "bb-kanban-mcp-"));
  try {
    const path = join(folder, "input.json");
    await writeFile(path, JSON.stringify(input), { mode: 0o600 });
    const { stdout } = await exec(cli.command, [...cli.prefix, "plugin", "rpc", "call", pluginId, method,
      "--input-file", path, "--json"], { env, windowsHide: true, signal, timeout: 65000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    // Some Windows BB builds exit with a libuv shutdown assertion after writing valid successful JSON.
    if (!signal?.aborted && !error.killed && error.stdout && String(error.stderr).includes("UV_HANDLE_CLOSING")) {
      try {
        const result = JSON.parse(error.stdout);
        if (!result || result.ok !== false) return result;
        throw new Error(result.error?.message || "BB RPC failed");
      } catch (parsed) { if (parsed instanceof SyntaxError) { /* Use the bounded error below. */ } else throw parsed; }
    }
    throw new Error(String(error.stderr || error.message).slice(0, 2000));
  } finally { await rm(folder, { recursive: true, force: true }); }
}

export function createKanbanMcp({ call = callBb, env = process.env } = {}) {
  const server = new McpServer({ name: "bb-kanban", version: "1.0.0" }, {
    instructions: "Inspect Kanban through its tools. Server snapshots do not prove rendered UI visibility. " +
      "ui_snapshot comes from live BB windows. ui_open creates a separate observer of the real BB app; " +
      "its filters are separate from the user's original window. Capture that window and close it after verification.",
  });
  for (const tool of toolDefinitions) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.parameters,
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: false } }, async (input, ctx) => {
      try {
        const scoped = { ...input };
        if (tool.name === "kanban_ui_open" && !scoped.threadId && env.BB_THREAD_ID) scoped.threadId = env.BB_THREAD_ID;
        const result = await call(tool.method, scoped, { env, signal: ctx.signal });
        if (tool.name === "kanban_ui_capture") {
          const { base64, ...metadata } = result;
          if (typeof base64 !== "string" || result.mimeType !== "image/jpeg") throw new Error("BB returned an invalid screenshot");
          return { content: [{ type: "text", text: JSON.stringify(metadata) }, { type: "image", data: base64, mimeType: "image/jpeg" }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) { return { content: [{ type: "text", text: String(error.message).slice(0, 2000) }], isError: true }; }
    });
  }
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serveStdio(() => createKanbanMcp(), { onerror: (error) => process.stderr.write(String(error.message).slice(0, 2000) + "\n") });
}
