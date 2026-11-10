import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const windows = process.platform === "win32";
const result = spawnSync(windows ? (process.env.ComSpec || "cmd.exe") : "npm",
  windows ? ["/d", "/s", "/c", "npm pack --dry-run --json --ignore-scripts"] : ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { encoding: "utf8" });
assert.equal(result.status, 0, result.stderr || String(result.error));
const [pack] = JSON.parse(result.stdout);
const paths = new Set(pack.files.map(file => file.path));
for (const file of ["server.ts", "app.tsx", "host.ts", "settings-ui.tsx", "settings-server.ts", "README.md", "PLUGIN_OVERVIEW.md", "LICENSE",
  "dist/app.js", "dist/app.css", "dist/app.meta.json", "dist/server.js", "dist/server.meta.json", "dist/host.js", "dist/host.meta.json"]) {
  assert.ok(paths.has(file), `Missing release file: ${file}`);
}
for (const file of paths) {
  assert.doesNotMatch(file, /(?:^|\/)(?:node_modules|\.git|host-data|thread-storage)(?:\/|$)|\.bb-deployment\.json$|\.test\.|(?:\.sqlite|\.db)(?:-|$)|\.env(?:\.|$)|\.map$/i,
    `Private or development artifact in release: ${file}`);
  if (/\.(?:ts|tsx|js|mjs|json|css|md)$/.test(file)) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /[a-z]:[\\/]+Users[\\/]+(?!Public\b|Default\b)[^\\/\s"']+|https?:\/\/[a-z0-9-]+\.getbb\.app|(?:proj_(?!personal\b)|host_|thr_)[a-z0-9]{10,}/i,
      `Personal machine reference in release: ${file}`);
  }
}
for (const kind of ["app", "server", "host"]) {
  const meta = JSON.parse(readFileSync(`dist/${kind}.meta.json`, "utf8"));
  assert.equal(meta.pluginId, "thread-kanban");
  assert.equal(meta.pluginVersion, manifest.version);
}
console.log(JSON.stringify({ version: manifest.version, files: paths.size, unpackedBytes: pack.unpackedSize, privateData: false }));
