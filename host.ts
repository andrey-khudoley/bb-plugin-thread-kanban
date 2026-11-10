import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdtemp, open, readFile, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import type { z } from "zod";
import { hasConflictMarkers, mergeHostRpc, type MergeConflict, type Resolution } from "./merge-contract";
import { commitMessage } from "./commit-message";

const run = promisify(execFile);
const main = "refs/heads/main";
const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete gitEnv[key];
const merges = new Set<string>();
type Candidate = z.infer<typeof mergeHostRpc.inspectWorktrees.input>["candidates"][number];
type Snapshot = z.infer<typeof mergeHostRpc.inspectWorktrees.output>["candidates"][number];

function git(cwd: string, args: string[], signal?: AbortSignal, respectCommitConfig = false, index?: string) {
  const overrides = respectCommitConfig ? [] : ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "merge.gpgSign=false"];
  return run("git", ["-c", "core.fsmonitor=false", ...overrides, ...args], {
    cwd, signal, env: { ...gitEnv, ...(index && { GIT_INDEX_FILE: index }) },
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  }).then(({ stdout }) => stdout);
}

function exitCode(error: unknown, code: number) {
  return (error as { code?: unknown } | null)?.code === code;
}
function pathKey(path: string) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
async function repository(path: string, signal?: AbortSignal) {
  if (!isAbsolute(path)) throw new Error("Git требует абсолютный путь к рабочей папке.");
  const cwd = await realpath(path);
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal);
  return { cwd, key: pathKey(await realpath(common.trim())) };
}
async function isAncestor(root: string, a: string, b: string, signal: AbortSignal) {
  try {
    await git(root, ["merge-base", "--is-ancestor", a, b], signal);
    return true;
  } catch (error) {
    if (exitCode(error, 1)) return false;
    throw error;
  }
}
const rev = (root: string, ref: string, signal: AbortSignal) =>
  git(root, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"], signal).then((s) => s.trim());
const clean = (path: string, signal: AbortSignal) =>
  git(path, ["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=none"], signal).then((s) => !s);
const branchRef = (path: string, signal: AbortSignal) => git(path, ["symbolic-ref", "--quiet", "HEAD"], signal).then((s) => s.trim());

async function gitPath(cwd: string, path: string, signal: AbortSignal) {
  return (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", path], signal)).trimEnd();
}

async function creation(cwd: string, ref: string, signal: AbortSignal) {
  const file = await open(await gitPath(cwd, `logs/${ref}`, signal), "r").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!file) return null;
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await file.read(buffer);
    const line = buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0];
    const match = /^(0{40}|0{64}) ([a-f0-9]{40}|[a-f0-9]{64}) .+> (\d+) [+-]\d{4}\t(.*)$/.exec(line);
    if (!match || match[1].length !== match[2].length || (ref !== "HEAD" && !match[4].startsWith("branch: Created from "))) return null;
    return { sha: match[2], at: Number(match[3]) * 1000 };
  } finally {
    await file.close();
  }
}

async function diffFiles(cwd: string, revisions: string[], signal: AbortSignal, index?: string) {
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames",
    "--ignore-submodules=dirty", "--src-prefix=a/", "--dst-prefix=b/"];
  const [patch, names] = await Promise.all([
    git(cwd, [...args, "--patch", ...revisions, "--"], signal, false, index),
    git(cwd, [...args, "--name-status", "-z", ...revisions, "--"], signal, false, index),
  ]).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error("Размер изменений превышает лимит просмотра (4 МБ).");
    }
    throw error;
  });
  const patches = patch ? patch.split(/(?=^diff --git )/m) : [];
  const fields = names.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i++];
    if (status.startsWith("R") || status.startsWith("C")) i++;
    paths.push(fields[i++]);
  }
  if (patches.length !== paths.length) throw new Error("Git вернул неполный список изменений.");
  return paths.map((name, i) => ({ name, patch: patches[i] }));
}

async function readGitHistory(input: z.infer<typeof mergeHostRpc.readGitHistory.input>, signal: AbortSignal) {
  const { cwd } = await repository(input.path, signal);
  const ref = input.branch ? `refs/heads/${input.branch}` : "HEAD";
  const head = await rev(cwd, input.shared ? ref : input.head ?? ref, signal);
  const hasBase = input.base && await isAncestor(cwd, input.base, head, signal);
  if (!input.shared && !hasBase) return [];
  const range = hasBase ? `${input.base}..${head}` : head;
  const log = await git(cwd, ["log", "--first-parent", "--max-count=200", "--format=%H%x00%P%x00%ct%x00%s", range], signal);
  const commits = log.trimEnd().split("\n").filter(Boolean).flatMap((line) => {
    const [sha, parents, time, subject] = line.split("\0");
    const [parent] = parents.split(" ");
    return parent ? [{ sha, parent, parents, subject, committedAt: Number(time) * 1000 }] : [];
  });
  if (!input.shared) return commits.map((commit) => ({ ...commit, source: "branch" as const, files: null }));

  const { threadId, dirtyPaths, evidence } = input.shared;
  const reflog = await git(cwd, ["reflog", "show", "--format=%H%x00%gs", ref], signal);
  const labels = new Set(reflog.trimEnd().split("\n"));
  const found = new Map<string, z.infer<typeof mergeHostRpc.readGitHistory.output>[number]>();
  const matches = evidence.map(() => [] as z.infer<typeof mergeHostRpc.readGitHistory.output>[number][]);
  for (const commit of commits) {
    const marked = commit.parents === commit.parent && labels.has(`${commit.sha}\0bb-kanban:${threadId}: ${commit.subject}`);
    const candidates = hasBase ? evidence.flatMap((entry, index) =>
      entry.files.length && commit.committedAt >= Math.floor(entry.startedAt / 1000) * 1000 &&
        (entry.before === null || commit.committedAt < entry.before) ? [index] : []) : [];
    if (!marked && !candidates.length) continue;
    const files = await diffFiles(cwd, [commit.parent, commit.sha], signal).catch((error) => {
      signal.throwIfAborted();
      if (error instanceof Error && error.message.includes("4 МБ")) return null;
      throw error;
    });
    if (marked) {
      const dirty = new Set(dirtyPaths ?? []);
      const scoped = files?.filter(({ name }) => !dirty.has(name)).map(({ name }) => name) ?? null;
      found.set(commit.sha, { ...commit, source: "thread", files: scoped, ...(files && { fileCount: files.length }) });
    }
    if (!files) continue;
    const actual = new Map(files.map(({ name, patch }) => [name, patch]));
    for (const index of candidates) {
      const expected = evidence[index].files;
      if (expected.every(({ name, patch }) => actual.get(name) === patch)) {
        matches[index].push({ ...commit, source: "matched", files: expected.map(({ name }) => name), fileCount: files.length });
      }
    }
  }
  for (const matchesForRun of matches) {
    if (matchesForRun.length !== 1) continue;
    const match = matchesForRun[0];
    const existing = found.get(match.sha);
    if (existing?.files && match.files) {
      found.set(match.sha, { ...existing, files: [...new Set([...existing.files, ...match.files])] });
    } else if (!existing) found.set(match.sha, match);
  }
  return [...found.values()].sort((a, b) => b.committedAt - a.committedAt);
}

async function workingDiff(cwd: string, base: string, signal: AbortSignal) {
  const folder = await mkdtemp(join(tmpdir(), "bb-kanban-diff-"));
  const index = join(folder, "index");
  try {
    const source = await gitPath(cwd, "index", signal);
    await copyFile(source, index).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await git(cwd, ["read-tree", "HEAD"], signal, false, index);
    });
    await git(cwd, ["add", "-A", "--", "."], signal, false, index);
    return await diffFiles(cwd, ["--cached", base], signal, index);
  } finally {
    await unlink(index).catch(() => {});
    await unlink(index + ".lock").catch(() => {});
    await rmdir(folder).catch(() => {});
  }
}

async function matchesReview(cwd: string, head: string, files: Awaited<ReturnType<typeof diffFiles>>,
  review: Pick<SharedReview, "snapshot" | "latest">,
  signal: AbortSignal) {
  const candidates = [review.snapshot, review.latest].filter((snapshot) => snapshot != null);
  const expected = JSON.stringify(files);
  if (candidates.some((snapshot) => JSON.stringify(snapshot.files) === expected)) return true;
  if (!candidates.length) return false;
  const folder = await mkdtemp(join(tmpdir(), "bb-kanban-review-"));
  const index = join(folder, "index");
  const patchFile = join(folder, "review.patch");
  try {
    for (const candidate of candidates) {
      await git(cwd, ["read-tree", head], signal, false, index);
      if (!candidate.files.length) continue;
      await writeFile(patchFile, candidate.files.map(({ patch }) => patch).join(""));
      const applied = await git(cwd, ["apply", "--cached", "--recount", "--whitespace=nowarn", patchFile], signal, false, index)
        .then(() => true, () => false);
      signal.throwIfAborted();
      if (applied && JSON.stringify(await diffFiles(cwd, ["--cached", head], signal, index)) === expected) return true;
    }
    return false;
  } finally {
    for (const file of [index, index + ".lock", patchFile]) await unlink(file).catch(() => {});
    await rmdir(folder).catch(() => {});
  }
}

type SharedReview = z.infer<typeof mergeHostRpc.reviewSharedCheckout.input>;
const literalPaths = (paths: string[]) => paths.map((path) => `:(top,literal)${path}`);

async function reviewSharedCheckout(cwd: string, branch: string, head: string, input: SharedReview, signal: AbortSignal):
  Promise<z.infer<typeof mergeHostRpc.reviewSharedCheckout.output>> {
  const ready = (commit: z.infer<typeof mergeHostRpc.commitCheckout.output> = null) => ({ outcome: "ready" as const, commit });
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"], signal)).trimEnd();
  const indexPath = await gitPath(root, "index", signal);
  const lockPath = indexPath + ".lock";
  const folder = await mkdtemp(join(tmpdir(), "bb-kanban-scoped-review-"));
  const staged = join(folder, "staged");
  const working = join(folder, "working");
  const selected = join(folder, "selected");
  const messagePath = join(folder, "message");
  const patchPath = join(folder, "selection.patch");
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let ownsLock = false;
  try {
    // Git writers honor index.lock. Keep it until the checked tree and the updated index are published.
    lock = await open(lockPath, "wx");
    ownsLock = true;
    const verifyHead = async () => {
      if (await branchRef(root, signal) !== branch || await rev(root, "HEAD", signal) !== head) {
        throw new Error("Ветка или HEAD изменились. Обнови изменения и повтори проверку.");
      }
    };
    await verifyHead();
    const status = () => git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames",
      "--ignore-submodules=none"], signal);
    const entries = await status();
    const dirty = [...new Set(entries.split("\0").filter(Boolean).map((entry) => entry.slice(3)))];
    if (!dirty.length && !input.resolution) return ready();
    await copyFile(indexPath, staged).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await git(root, ["read-tree", head], signal, false, staged);
    });
    const tree = async (index: string) => (await git(root, ["write-tree"], signal, false, index)).trim();
    const originalTree = await tree(staged);
    const indexEntries = await git(root, ["ls-files", "--stage", "-z"], signal, false, staged);
    const stageWorking = async () => {
      await copyFile(staged, working);
      await git(root, ["add", "-A", "--", "."], signal, false, working);
      return tree(working);
    };
    const workingTree = await stageWorking();
    const revision = createHash("sha256").update(JSON.stringify([branch, head, entries, indexEntries, workingTree])).digest("hex");
    const blocked = (paths: string[], reason: string) => ({ outcome: "blocked" as const, revision, paths, message: reason });
    const changed = async (before: string, after: string, paths: string[] = []) =>
      (await git(root, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--ignore-submodules=none",
        before, after, "--", ...literalPaths(paths)], signal)).split("\0").filter(Boolean);
    const stagedPaths = await changed(head, originalTree);
    const workPaths = await changed(head, workingTree);
    let task: string[];
    if (input.resolution) {
      const { revision: expected, task: confirmed, foreign, patch } = input.resolution;
      const classified = new Set([...confirmed, ...foreign]);
      if (expected !== revision || classified.size !== confirmed.length + foreign.length ||
          classified.size !== dirty.length || dirty.some((path) => !classified.has(path)) || (patch && !confirmed.length)) {
        return blocked(dirty, "Состояние Git или список правок изменились. Проверь принадлежность заново.");
      }
      task = confirmed;
    } else {
      const files = await diffFiles(root, [head, workingTree], signal);
      const patches = new Map(files.map((file) => [file.name, file.patch]));
      const history = input.snapshot?.branch === input.expectedBranch ? input.snapshot.files : [];
      const latest = input.latest?.branch === input.expectedBranch ? input.latest.files : [];
      const known = new Set([...history, ...latest].map(({ name }) => name));
      const committed = new Set<string>();
      for (const commit of input.committed) {
        if (!commit.files?.length || !await isAncestor(root, commit.sha, head, signal)) continue;
        for (const name of commit.files) committed.add(name);
        for (const name of await changed(commit.parent, commit.sha)) known.add(name);
      }
      const alreadySaved = new Set(committed);
      if (history.length || latest.length) {
        await git(root, ["read-tree", head], signal, false, selected);
        for (const { name, patch } of [...history, ...latest]) {
          if (dirty.includes(name) || alreadySaved.has(name)) continue;
          await writeFile(patchPath, patch);
          const reversed = await git(root, ["apply", "--cached", "--reverse", "--check", "--recount", patchPath],
            signal, false, selected).then(() => true, () => false);
          signal.throwIfAborted();
          if (reversed) alreadySaved.add(name);
        }
      }
      const candidates = history.length ? [history] : [latest];
      const matches = candidates.filter((candidate) => candidate.length &&
        candidate.every(({ name, patch }) => dirty.includes(name) ? patches.get(name) === patch : alreadySaved.has(name)));
      const proven = new Set(matches.flatMap((candidate) => candidate.filter(({ name, patch }) => patches.get(name) === patch)
        .map(({ name }) => name)));
      const overlap = dirty.filter((name) => known.has(name) && !proven.has(name));
      // A full match can also normalize a patch after HEAD moved since the chat started.
      const whole = dirty.every((path) => workPaths.includes(path)) && files.length &&
        await matchesReview(root, head, files, {
          snapshot: history.length ? input.snapshot : null,
          latest: !history.length || history.every(({ name }) => alreadySaved.has(name) || latest.some((file) => file.name === name))
            ? input.latest : undefined,
        }, signal);
      if (whole) {
        task = dirty;
      } else if (input.requireFull || overlap.length || (!matches.length && (history.length || latest.length || !committed.size)) ||
          files.some(({ patch }) => /^rename from /m.test(patch))) {
        return blocked(overlap.length ? overlap : dirty, "В общей рабочей папке есть правки, которые нельзя целиком отнести к карточке.");
      } else {
        task = dirty.filter((name) => proven.has(name));
      }
    }
    const stagedDiffer = new Set(await changed(originalTree, workingTree));
    const unsafe = task.filter((path) => !workPaths.includes(path) ||
      (stagedPaths.includes(path) && (input.resolution?.patch || stagedDiffer.has(path))));
    if (unsafe.length) return blocked(unsafe, "Подготовленная версия или содержимое файлов отличается от правок карточки.");
    if (!task.length) {
      await verifyHead();
      if (entries !== await status() || workingTree !== await stageWorking()) {
        return blocked(dirty, "Правки изменились во время проверки. Повтори проверку.");
      }
      return ready();
    }
    await git(root, ["read-tree", head], signal, false, selected);
    if (input.resolution?.patch) {
      await writeFile(patchPath, input.resolution.patch, { flag: "wx" });
      const args = ["apply", "--cached", "--whitespace=nowarn", "--recount"];
      try {
        await git(root, [...args, "--reverse", "--check", patchPath], signal, false, working);
        await git(root, [...args, patchPath], signal, false, selected);
      } catch {
        signal.throwIfAborted();
        return blocked(task, "Выбранные фрагменты нельзя применить к HEAD и подтвердить в рабочей копии.");
      }
    } else {
      await git(root, ["reset", "--quiet", workingTree, "--", ...literalPaths(task)], signal, false, selected);
    }
    const commitTree = await tree(selected);
    const paths = await changed(head, commitTree);
    if (paths.length !== task.length || paths.some((path) => !task.includes(path))) {
      return blocked(dirty, "Не удалось выделить точный состав коммита.");
    }
    const fields = (await git(root, ["diff", "--name-status", "-z", "--no-renames", head, commitTree, "--"], signal)).split("\0");
    const changes = [];
    for (let i = 0; i + 1 < fields.length; i += 2) changes.push({ kind: fields[i], path: fields[i + 1] });
    const { subject, body } = commitMessage(input.title, changes);
    await writeFile(messagePath, `${subject}\n\n${body}\n`, { flag: "wx" });
    // The commit is made from an immutable tree, never by staging the live folder after approval.
    // Repositories with commit hooks still need the regular Git commit workflow.
    const configuredHooks = await git(root, ["config", "--path", "--get", "core.hooksPath"], signal, true)
      .then((value) => value.trimEnd(), (error) => { if (exitCode(error, 1)) return ""; throw error; });
    const hooks = configuredHooks
      ? (isAbsolute(configuredHooks) ? configuredHooks : join(root, configuredHooks))
      : await gitPath(root, "hooks", signal);
    for (const hook of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "reference-transaction"]) {
      const enabled = await access(join(hooks, hook), constants.X_OK).then(() => true, (error) => {
        if (["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
        throw error;
      });
      if (enabled) throw new Error(`В репозитории включён Git-хук ${hook}. Сохрани правки карточки штатным Git-коммитом и повтори проверку.`);
    }
    const sign = await git(root, ["config", "--type=bool", "--get", "commit.gpgSign"], signal, true)
      .then((value) => value.trim() === "true", (error) => { if (exitCode(error, 1)) return false; throw error; });
    const newHead = (await git(root, ["commit-tree", commitTree, "-p", head, "-F", messagePath, ...(sign ? ["-S"] : [])],
      signal, true)).trim();
    await verifyHead();
    if (entries !== await status() || workingTree !== await stageWorking()) {
      return blocked(dirty, "Правки изменились во время проверки. Повтори проверку.");
    }
    await git(root, ["reset", "--quiet", commitTree, "--", ...literalPaths(task)], signal, false, staged);
    await lock.writeFile(await readFile(staged));
    await lock.close();
    lock = undefined;
    await verifyHead();
    signal.throwIfAborted();
    await git(root, ["update-ref", "-m", `bb-kanban:${input.threadId}: ${subject}`, "HEAD", newHead, head]);
    try {
      await rename(lockPath, indexPath);
      ownsLock = false;
    } catch (error) {
      await git(root, ["update-ref", "-m", "bb-kanban: rollback index publication", "HEAD", head, newHead]);
      throw error;
    }
    return ready({ head: newHead, subject });
  } finally {
    await lock?.close();
    if (ownsLock) await unlink(lockPath);
    for (const file of [staged, working, selected, messagePath, patchPath]) {
      await unlink(file).catch(() => {});
      await unlink(file + ".lock").catch(() => {});
    }
    await rmdir(folder).catch(() => {});
  }
}

async function readWorkDiff(input: z.infer<typeof mergeHostRpc.readWorkDiff.input>, signal: AbortSignal) {
  const { branch, createdAt } = input;
  const ref = `refs/heads/${branch}`;
  const checkout = input.checkout ? await repository(input.checkout, signal).catch(() => null) : null;
  const root = input.root ? await repository(input.root, signal).catch(() => null) : checkout;
  if (signal.aborted) throw signal.reason;
  if (!root || (checkout && checkout.key !== root.key)) return null;
  await git(root.cwd, ["check-ref-format", ref], signal);
  const live = !input.mergedAt && !!checkout && await branchRef(checkout.cwd, signal).catch(() => null) === ref;
  if (checkout && !live && !input.mergedAt) return null;
  const cwd = live ? checkout.cwd : root.cwd;
  const head = input.head ?? await rev(cwd, live ? "HEAD" : ref, signal).catch(() => null);
  if (!head) return null;
  if (input.mergedAt && !await isAncestor(cwd, head, input.mergedAt, signal)) return null;
  if (input.knownHead && !await isAncestor(cwd, input.knownHead, head, signal)) return null;
  if (live && input.head && await rev(cwd, "HEAD", signal) !== head) return null;
  let base = input.base;
  if (!base) {
    const created = await creation(cwd, ref, signal);
    const initial = checkout ? await creation(checkout.cwd, "HEAD", signal) : null;
    if (initial && (!created || initial.sha === created.sha) && Math.abs(initial.at - createdAt) < 120_000) base = initial.sha;
    else if (created && Math.abs(created.at - createdAt) < 120_000) base = created.sha;
  }
  if (!base || !await isAncestor(cwd, base, head, signal)) return null;
  const files = input.revisionsOnly ? [] : live && !input.head
    ? await workingDiff(cwd, base, signal) : await diffFiles(cwd, [base, head], signal);
  if (live && (await rev(cwd, "HEAD", signal) !== head || await branchRef(cwd, signal) !== ref)) {
    throw new Error("Ветка изменилась во время чтения. Обнови изменения.");
  }
  return { base, head, branch, files };
}
async function sharedWorkOrigin(path: string, signal: AbortSignal) {
  if (!isAbsolute(path)) throw new Error("Git требует абсолютный путь к рабочей папке.");
  const cwd = await realpath(path);
  const isCheckout = await git(cwd, ["rev-parse", "--is-inside-work-tree"], signal).catch((error) => {
    if (exitCode(error, 128) && /not a git repository/.test(String(error))) return "";
    throw error;
  });
  if (isCheckout.trim() !== "true") return null;
  const branch = await branchRef(cwd, signal);
  const base = await rev(cwd, "HEAD", signal);
  const { count, files } = await changedFiles(cwd, signal);
  if (await branchRef(cwd, signal) !== branch || await rev(cwd, "HEAD", signal) !== base) {
    throw new Error("Ветка изменилась при фиксации исходной ревизии.");
  }
  return { base, branch: branch.slice("refs/heads/".length), dirtyPaths: count === files.length ? files : null };
}

function chatEditName(roots: string[], path: string) {
  const absolute = resolve(roots[0], path);
  for (const root of roots.slice().sort((a, b) => b.length - a.length)) {
    const name = relative(root, absolute).split(sep).join("/");
    if (name && !isAbsolute(name) && name !== ".." && !name.startsWith("../")) return name;
  }
  // A chat also edits reports and helper scripts outside its repository.
  return null;
}

function chatEditPatch(name: string, edit: z.infer<typeof mergeHostRpc.readSharedWorkDiff.input>["edits"][number]) {
  if (!name || isAbsolute(name) || name === ".." || name.startsWith("../") || /[\x00-\x1f\x7f"\\]/.test(name)) {
    throw new Error("Патч чата ссылается на неподдерживаемый путь.");
  }
  const header = `diff --git a/${name} b/${name}\n`;
  const diff = edit.diff.replace(/\r\n/g, "\n");
  if (edit.kind === "update") return header + `--- a/${name}\t\n+++ b/${name}\t\n` + diff.replace(/\n?$/, "\n");

  // Codex records the contents of added/deleted files, and hunks for updates.
  const add = edit.kind === "add";
  const mode = add ? "new file" : "deleted file";
  const lines = diff ? diff.replace(/\n$/, "").split("\n") : [];
  if (!lines.length) return header + `${mode} mode 100644\n`;
  const range = lines.length === 1 ? "1" : `1,${lines.length}`;
  const hunk = add ? `@@ -0,0 +${range} @@\n` : `@@ -${range} +0,0 @@\n`;
  const before = add ? "/dev/null" : `a/${name}`;
  const after = add ? `b/${name}` : "/dev/null";
  return header + `${mode} mode 100644\n--- ${before}\t\n+++ ${after}\t\n` + hunk +
    lines.map((line) => (add ? "+" : "-") + line + "\n").join("") +
    (diff.endsWith("\n") ? "" : "\\ No newline at end of file\n");
}

async function readSharedWorkDiff(input: z.infer<typeof mergeHostRpc.readSharedWorkDiff.input>, signal: AbortSignal) {
  const checkout = await sharedWorkOrigin(input.path, signal);
  if (!checkout) return null;
  const cwd = input.path;
  const branch = input.branch ?? checkout.branch;
  const ref = `refs/heads/${branch}`;
  await git(cwd, ["check-ref-format", ref], signal);
  const head = await rev(cwd, ref, signal);
  const entries = (await git(cwd, ["reflog", "show", "--format=%H%x00%gD%x00%gs", "--date=unix", ref], signal))
    .trimEnd().split("\n").filter(Boolean).map((line) => {
      const [sha, selector, message] = line.split("\0");
      return { sha, at: Number(/@\{(\d+)\}$/.exec(selector)?.[1]) * 1000, message };
    });
  // Reflog timestamps have second precision. A boundary in the same second is ambiguous.
  const startSecond = Math.floor(input.startedAt / 1000) * 1000;
  const base = input.base ?? (!entries.some(({ at }) => at === startSecond)
    ? entries.find(({ at }) => at < startSecond)?.sha : undefined);
  if (!base || !await isAncestor(cwd, base, head, signal)) {
    return { reason: "Не найдена исходная ревизия чата в журнале этой ветки." };
  }
  const marker = `bb-kanban:${input.threadId}: `;
  const runStartSecond = input.run ? Math.floor(input.run.startedAt / 1000) * 1000 : null;
  const runEnd = input.run?.endedAt;
  const runEndSecond = runEnd == null ? null : Math.floor(runEnd / 1000) * 1000;
  // A marked commit at a boundary can only be assigned with second precision.
  const candidates = new Map(entries.filter(({ at, message }) =>
    at + 1000 > input.startedAt && (runEndSecond === null || at < runEndSecond) &&
    (runStartSecond === null || runStartSecond === startSecond || at !== runStartSecond) &&
    message.startsWith(marker)).map((entry) => [entry.sha, entry]));
  const commits: { at: number; patch: string; commit: true; beforeRun: boolean }[] = [];
  let taskHead = base;
  if (candidates.size && input.dirtyPaths) {
    // A commit made by the chat may still stage files already dirty at launch.
    // Patches from the chat can attribute edits to these files separately.
    const exclusions = input.dirtyPaths.map((name) => `:(top,literal,exclude)${name}`);
    const history = await git(cwd, ["log", "--first-parent", "--reverse", "--format=%H%x00%P%x00%s", `${base}..${head}`], signal);
    for (const line of history.trimEnd().split("\n")) {
      const [sha, parent, subject] = line.split("\0");
      const entry = candidates.get(sha);
      // Checkout, reset, fast-forward and merge entries are not task commits.
      if (!entry || !parent || parent.includes(" ") || entry.message !== marker + subject) continue;
      const patch = await git(cwd, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv",
        "--no-color", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", parent, sha, "--", ...exclusions], signal);
      if (patch) {
        commits.push({ at: entry.at, patch, commit: true, beforeRun: runStartSecond !== null && entry.at < runStartSecond });
        taskHead = sha;
      }
    }
  }
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"], signal)).trimEnd();
  // Only Git's registered worktrees can map external paths into this repository.
  const worktrees = (await git(cwd, ["worktree", "list", "--porcelain", "-z"], signal))
    .split("\0").filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9));
  const roots = [root, ...worktrees.filter((path) => pathKey(path) !== pathKey(root))];
  const edits = input.edits.flatMap((edit) => {
    const name = chatEditName(roots, edit.path);
    return name === null ? [] : [{ at: Math.floor(edit.at / 1000) * 1000,
      patch: chatEditPatch(name, edit), commit: false, beforeRun: !!edit.beforeRun }];
  });
  if (!edits.some(({ beforeRun }) => !beforeRun) && !commits.some(({ beforeRun }) => !beforeRun)) {
    if (input.run) return { reason: "Для этого запуска нет сохранённых патчей или подтверждённых коммитов." };
    if (candidates.size) {
      return { reason: "Есть коммиты этого чата, но для их файлов не удалось отделить правки, которые уже были в рабочей папке до запуска." };
    }
    return { reason: "В журнале чата нет сохранённых патчей, а в Git нет коммитов, привязанных к этому чату." };
  }
  const folder = await mkdtemp(join(tmpdir(), "bb-kanban-shared-diff-"));
  const index = join(folder, "index");
  const patchFile = join(folder, "changes.patch");
  try {
    await git(root, ["read-tree", base], signal, false, index);
    let compareTo = base;
    const changes = [...edits, ...commits].sort((a, b) => Number(b.beforeRun) - Number(a.beforeRun) || a.at - b.at);
    for (const [position, { patch, commit, beforeRun }] of changes.entries()) {
      if (input.run && !beforeRun && changes[position - 1]?.beforeRun) {
        compareTo = (await git(root, ["write-tree"], signal, false, index)).trim();
      }
      await writeFile(patchFile, patch);
      const args = ["apply", "--cached", "--recount", "--whitespace=nowarn"];
      try {
        await git(root, [...args, patchFile], signal, false, index);
      } catch (error) {
        if (signal.aborted) throw error;
        // A committed patch may already be present because the chat recorded the edit first.
        try {
          await git(root, [...args, "--reverse", "--check", patchFile], signal, false, index);
        } catch {
          // Git can replay a commit over a different parent when its edits do not overlap.
          const applied = commit && await git(root, [...args, "--3way", patchFile], signal, false, index)
            .then(() => true, () => false);
          signal.throwIfAborted();
          if (!applied) return { reason: "Подтверждённые правки чата пересекаются с другими изменениями. Их общий diff нельзя собрать отдельно." };
        }
      }
    }
    if (await rev(cwd, ref, signal) !== head) return { reason: "Ветка изменилась при чтении истории. Обнови изменения." };
    return { base, head: taskHead, branch, shared: true as const, files: await diffFiles(root, ["--cached", compareTo], signal, index) };
  } finally {
    for (const file of [index, index + ".lock", patchFile]) await unlink(file).catch(() => {});
    await rmdir(folder).catch(() => {});
  }
}

async function changedFiles(path: string, signal: AbortSignal) {
  const files = (await git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames",
    "--ignore-submodules=none"], signal)).split("\0").filter(Boolean).map((entry) => entry.slice(3));
  return { files: files.slice(0, 200), count: files.length };
}
async function writeCommit(path: string, title: string, signal: AbortSignal, merge = false) {
  const fields = (await git(path, ["diff", "--cached", "--name-status", "--no-renames", "-z"], signal)).split("\0");
  const changes = [];
  for (let i = 0; i + 1 < fields.length; i += 2) changes.push({ kind: fields[i], path: fields[i + 1] });
  if (!changes.length && !merge) return null;
  const { subject, body } = commitMessage(title, changes, merge);
  const folder = await mkdtemp(join(await realpath(tmpdir()), "bb-kanban-commit-"));
  const file = join(folder, "message");
  try {
    await writeFile(file, `${subject}\n\n${body}\n`, { flag: "wx" });
    await git(path, ["commit", "--cleanup=verbatim", "-F", file], signal, !merge);
  } finally {
    await unlink(file).catch(() => {});
    await rmdir(folder).catch(() => {});
  }
  return { head: await rev(path, "HEAD", signal),
    subject: (await git(path, ["log", "-1", "--format=%s"], signal)).trim() };
}

async function inspect(root: Awaited<ReturnType<typeof repository>>, base: string, candidate: Candidate, includeFiles: boolean, signal: AbortSignal): Promise<Snapshot> {
  let branch = candidate.branch;
  try {
    const worktree = candidate.path ? await repository(candidate.path, signal) : null;
    if (worktree && (worktree.key !== root.key || pathKey(worktree.cwd) === pathKey(root.cwd))) {
      throw new Error("Окружение должно быть отдельным worktree этого репозитория.");
    }
    const ref = worktree ? await branchRef(worktree.cwd, signal) : `refs/heads/${branch ?? ""}`;
    if (!ref.startsWith("refs/heads/") || ref === main) throw new Error("Нужна отдельная локальная ветка.");
    await git(root.cwd, ["check-ref-format", ref], signal);
    branch = ref.slice("refs/heads/".length);
    const head = await rev(root.cwd, ref, signal);
    const changes = worktree && !await clean(worktree.cwd, signal);
    if (changes) return { id: candidate.id, branch, head, state: "dirty", files: [], message: "Есть незакоммиченные изменения в worktree.",
      ...(includeFiles ? { changes: await changedFiles(worktree.cwd, signal) } : {}) };
    if (await isAncestor(root.cwd, head, base, signal)) {
      // A new worktree starts on an existing commit and has had no work to merge yet.
      const history = await git(root.cwd, ["reflog", "show", "--format=%H%x09%gs", ref, "--"], signal);
      if (history.trimEnd().split("\n").at(-1)?.startsWith(`${head}\tbranch: Created from `)) {
        return { id: candidate.id, branch, head, state: "empty", files: [], message: "В ветке пока нет собственных коммитов." };
      }
      return { id: candidate.id, branch, head, state: "merged", files: [], message: "Все коммиты ветки уже в main." };
    }
    const files = includeFiles
      ? (await git(root.cwd, ["diff", "--name-only", "-z", `${base}...${head}`], signal)).split("\0").filter(Boolean).slice(0, 80)
      : [];
    return { id: candidate.id, branch, head, state: "pending", files, message: "Есть коммиты вне main." };
  } catch (cause) {
    if (signal.aborted) throw cause;
    return { id: candidate.id, branch, head: null, state: "unavailable", files: [],
      message: cause instanceof Error ? cause.message.split("\n").slice(-3).join(" ").slice(0, 400) : String(cause) };
  }
}

async function checkMain(root: string, base: string, signal: AbortSignal) {
  if (await branchRef(root, signal) !== main) throw new Error("Открой ветку main в основной рабочей папке проекта.");
  if (await rev(root, main, signal) !== base) throw new Error("Ветка main изменилась. Подготовь план заново.");
  if (!await clean(root, signal)) throw new Error("В основной рабочей папке есть незакоммиченные изменения.");
  await checkNoGitOperation(root, signal);
}

async function checkNoGitOperation(root: string, signal: AbortSignal) {
  for (const ref of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"]) {
    const exists = await git(root, ["rev-parse", "--verify", "--quiet", ref], signal).then(() => true, (error) => {
      if (exitCode(error, 1)) return false;
      throw error;
    });
    if (exists) throw new Error("Сначала заверши текущую Git-операцию в рабочей папке.");
  }
}

type Stage = { mode: string; blob: string };
type Stages = [Stage?, Stage?, Stage?];
type FileConflict = { id: string; path: string; stages: Stages };
const textModes = new Set(["100644", "100755"]);
async function readConflicts(scratch: string, head: string, signal: AbortSignal) {
  const files = new Map<string, Stages>();
  for (const entry of (await git(scratch, ["ls-files", "-u", "-z"], signal)).split("\0").filter(Boolean)) {
    const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([123])\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("Git вернул неизвестный формат конфликтующего файла.");
    const [, mode, blob, stage, path] = match;
    const stages = files.get(path) ?? [];
    stages[Number(stage) - 1] = { mode, blob };
    files.set(path, stages);
  }
  return [...files].map(([path, stages]): FileConflict => ({
    path, stages, id: createHash("sha256").update(JSON.stringify([head, path, ...stages])).digest("hex"),
  }));
}

async function describeConflict(scratch: string, branch: string, file: FileConflict, signal: AbortSignal): Promise<MergeConflict> {
  async function side(stage?: Stage) {
    if (!stage) return { exists: false, mode: null, text: null };
    let text = null;
    if (textModes.has(stage.mode) && Number(await git(scratch, ["cat-file", "-s", stage.blob], signal)) <= 12000) {
      const content = await git(scratch, ["cat-file", "blob", stage.blob], signal);
      if (!/[\x00\uFFFD]/.test(content)) text = content;
    }
    return { exists: true, mode: stage.mode, text };
  }
  const [base, current, incoming] = await Promise.all([side(file.stages[0]), side(file.stages[1]), side(file.stages[2])]);
  const text = current.text !== null && incoming.text !== null && (!base.exists || base.text !== null)
    && current.mode === incoming.mode && (!base.exists || base.mode === current.mode);
  return { id: file.id, path: file.path, branch, text, base, current, incoming };
}

async function applyResolution(scratch: string, file: FileConflict, resolution: Resolution, signal: AbortSignal) {
  // Pathspecs come from Git's index and are always treated as literal paths.
  let stage = file.stages[resolution.kind === "incoming" ? 2 : 1];
  if (resolution.kind === "text") {
    const other = file.stages[2];
    if (!stage || !other || stage.mode !== other.mode || !textModes.has(stage.mode) ||
      hasConflictMarkers(resolution.text) || resolution.text.includes("\0")) {
      throw new Error(`Недопустимое текстовое решение для ${file.path}.`);
    }
    const temp = await mkdtemp(join(dirname(scratch), "bb-kanban-blob-"));
    const blobPath = join(temp, "content");
    try {
      await writeFile(blobPath, resolution.text, { flag: "wx" });
      const blob = (await git(scratch, ["hash-object", "-w", "--no-filters", "--", blobPath], signal)).trim();
      stage = { mode: stage.mode, blob };
    } finally {
      await unlink(blobPath).catch(() => {});
      await rmdir(temp).catch(() => {});
    }
  }
  if (!stage) {
    await git(scratch, ["--literal-pathspecs", "rm", "-f", "--", file.path], signal);
    return;
  }
  await git(scratch, ["update-index", "--add", "--cacheinfo", `${stage.mode},${stage.blob},${file.path}`], signal);
  await git(scratch, ["--literal-pathspecs", "checkout-index", "--force", "--", file.path], signal);
}

async function tryMerge<T>(
  { root, base, candidates, resolutions }: z.infer<typeof mergeHostRpc.mergeWorktrees.input>,
  signal: AbortSignal,
  finish: (root: string, scratch: string, base: string, signal: AbortSignal) => T | Promise<T>,
) {
  const repo = await repository(root, signal);
  if (merges.has(repo.key)) throw new Error("В этом репозитории уже идёт слияние.");
  merges.add(repo.key);
  let scratch: string | undefined;
  let tempRoot: string | undefined;
  let added = false;
  try {
    await checkMain(repo.cwd, base, signal);
    for (const candidate of candidates) {
      const current = await inspect(repo, base, candidate, false, signal);
      if (current.head !== candidate.head || current.branch !== candidate.branch || current.state !== "pending") {
        throw new Error(`${candidate.branch} изменилась или стала недоступна. Подготовь план заново.`);
      }
    }
    tempRoot = await realpath(tmpdir());
    scratch = await mkdtemp(join(tempRoot, "bb-kanban-merge-"));
    await git(repo.cwd, ["worktree", "add", "--detach", "--", scratch, base], signal);
    added = true;
    for (const candidate of candidates) {
      if (await isAncestor(scratch, candidate.head, "HEAD", signal)) continue;
      try {
        await git(scratch, ["merge", "--no-ff", "--no-commit", "--no-autostash", candidate.head], signal);
      } catch (cause) {
        if (signal.aborted) throw cause;
        const files = await readConflicts(scratch, candidate.head, signal);
        if (files.length) {
          const pending = files.filter(({ id }) => !Object.hasOwn(resolutions, id));
          if (pending.length) {
            const conflicts = await Promise.all(pending.slice(0, 6).map((file) =>
              describeConflict(scratch!, candidate.branch!, file, signal)));
            return { outcome: "conflict" as const, conflicts };
          }
          for (const file of files) await applyResolution(scratch, file, resolutions[file.id], signal);
          if ((await readConflicts(scratch, candidate.head, signal)).length) throw new Error("В индексе остались конфликты.");
          await git(scratch, ["diff", "--cached", "--check"], signal);
        } else {
          const detail = (cause as { stderr?: string }).stderr?.trim().slice(0, 800);
          throw new Error(`Git не смог слить ${candidate.branch}.${detail ? " " + detail : ""}`);
        }
      }
      await writeCommit(scratch, `Слить ${candidate.branch} в main`, signal, true);
    }
    return await finish(repo.cwd, scratch, base, signal);
  } finally {
    try {
      if (scratch) {
        const path = await realpath(scratch).catch(() => null);
        if (path && tempRoot && pathKey(dirname(path)) === pathKey(tempRoot) && pathKey(path) === pathKey(scratch)) {
          if (added) await git(repo.cwd, ["worktree", "remove", "--force", "--", path]);
          else await rmdir(path).catch(() => {});
        }
      }
    } finally {
      merges.delete(repo.key);
    }
  }
}

export default experimental_defineHostEntry({
  contract: mergeHostRpc,
  handlers: {
    async readGitHistory(input, { signal }) {
      return await readGitHistory(input, signal);
    },
    async readGitCommitPatch({ path, sha, parent, files }, { signal }) {
      const { cwd } = await repository(path, signal);
      const patch = await diffFiles(cwd, [parent, sha], signal);
      if (!files) return patch;
      const names = new Set(files);
      return patch.filter(({ name }) => names.has(name));
    },
    async sharedWorkOrigin({ path }, { signal }) {
      return await sharedWorkOrigin(path, signal);
    },
    async readSharedWorkDiff(input, { signal }) {
      return await readSharedWorkDiff(input, signal);
    },
    async readWorkDiff(input, { signal }) {
      return await readWorkDiff(input, signal);
    },
    async inspectCheckout({ path }, { signal }) {
      const { cwd } = await repository(path, signal);
      return { dirty: !await clean(cwd, signal) };
    },
    async reviewSharedCheckout(input, { signal }) {
      const repo = await repository(input.path, signal);
      if (merges.has(repo.key)) throw new Error("В этом репозитории уже выполняется Git-операция канбана.");
      merges.add(repo.key);
      try {
        await checkNoGitOperation(repo.cwd, signal);
        if (await git(repo.cwd, ["ls-files", "-u", "-z"], signal)) throw new Error("Сначала разреши конфликты в индексе Git.");
        const branch = await branchRef(repo.cwd, signal);
        if (branch !== `refs/heads/${input.expectedBranch}`) throw new Error("Рабочая ветка изменилась. Обнови изменения.");
        const head = await rev(repo.cwd, "HEAD", signal).catch((error) => {
          if (exitCode(error, 128) && input.expectedHead === null) return null;
          throw error;
        });
        if (head !== input.expectedHead) throw new Error("Коммит ветки изменился. Обнови изменения и проверь их снова.");
        if (!head) {
          if (await clean(repo.cwd, signal)) return { outcome: "ready" as const, commit: null };
          throw new Error("Для проверки общей рабочей папки нужен исходный коммит.");
        }
        return await reviewSharedCheckout(repo.cwd, branch, head, input, signal);
      } finally {
        merges.delete(repo.key);
      }
    },
    async commitCheckout({ path, title, expectedHead, expectedBranch, expectedFiles }, { signal }) {
      const repo = await repository(path, signal);
      if (merges.has(repo.key)) throw new Error("В этом репозитории уже выполняется Git-операция канбана.");
      merges.add(repo.key);
      try {
        await checkNoGitOperation(repo.cwd, signal);
        if (await git(repo.cwd, ["ls-files", "-u", "-z"], signal)) throw new Error("Сначала разреши конфликты в индексе Git.");
        const branch = await branchRef(repo.cwd, signal).catch(() => null);
        if (!branch || (expectedBranch && branch !== `refs/heads/${expectedBranch}`)) {
          throw new Error("Рабочая ветка изменилась. Обнови изменения и проверь их снова.");
        }
        if (expectedHead !== undefined) {
          const head = await rev(repo.cwd, "HEAD", signal).catch((error) => {
            if (exitCode(error, 128) && expectedHead === null) return null;
            throw error;
          });
          if (head !== expectedHead) throw new Error("Коммит ветки изменился. Обнови изменения и проверь их снова.");
        }
        if (expectedFiles) {
          const latest = await changedFiles(repo.cwd, signal);
          if (latest.count !== expectedFiles.length || JSON.stringify(latest.files) !== JSON.stringify(expectedFiles)) {
            throw new Error("Список файлов изменился. Обнови план и проверь правки.");
          }
        }
        if (await clean(repo.cwd, signal)) return null;
        await git(repo.cwd, ["add", "-A"], signal);
        return await writeCommit(repo.cwd, title, signal);
      } finally {
        merges.delete(repo.key);
      }
    },
    async inspectWorktrees({ root, candidates, includeFiles }, { signal }) {
      const repo = await repository(root, signal);
      const base = await rev(repo.cwd, main, signal);
      const rows: Snapshot[] = [];
      for (const candidate of candidates) rows.push(await inspect(repo, base, candidate, includeFiles, signal));
      if (!includeFiles) return { base, candidates: rows };
      const current = await branchRef(repo.cwd, signal).catch(() => null);
      if (current !== main) return { base, candidates: rows, mainIssue: "Открой ветку main в основной рабочей папке проекта." };
      return { base, candidates: rows, mainChanges: await changedFiles(repo.cwd, signal) };
    },
    mergeWorktrees(input, { signal }) {
      return tryMerge(input, signal, async (root, scratch, base, signal) => {
        const head = await rev(scratch, "HEAD", signal);
        await checkMain(root, base, signal);
        await git(root, ["merge", "--ff-only", "--no-autostash", head], signal);
        return { outcome: "merged" as const, head };
      });
    },
    previewMergeConflicts(input, { signal }) {
      return tryMerge(input, signal, () => ({ outcome: "previewed" as const }));
    },
  },
});
