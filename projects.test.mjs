import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { orderProjects, moveProject } from "./project-order.ts";
import plugin from "./dist/server.js";

test("manual order ignores stale and repeated IDs and appends new projects", () => {
  const projects = ["a", "b", "c"].map((id) => ({ id, name: id }));
  assert.deepEqual(orderProjects(projects, ["b", "deleted", "b", "a"]).map(({ id }) => id), ["b", "a", "c"]);
  assert.deepEqual(projects.map(({ id }) => id), ["a", "b", "c"]);
});

test("moves exactly one place in both directions, including one-project boundaries", () => {
  assert.deepEqual(moveProject(["a", "b", "c"], "b", "up"), ["b", "a", "c"]);
  assert.deepEqual(moveProject(["a", "b", "c"], "b", "down"), ["a", "c", "b"]);
  assert.deepEqual(moveProject(["a", "b"], "a", "up"), ["a", "b"]);
  assert.deepEqual(moveProject(["a", "b"], "b", "down"), ["a", "b"]);
  for (const direction of ["up", "down"]) {
    assert.deepEqual(moveProject(["a"], "a", direction), ["a"]);
    assert.deepEqual(moveProject(["a"], "missing", direction), ["a"]);
  }
});

test("order survives plugin reload and simultaneous moves; rename calls the shared project API", async (t) => {
  const projects = ["a", "b", "proj_personal"].map((id) => ({ id, name: id }));
  let { bb, harness } = createFakePluginHost({ sdk: { projects: {
    list: async () => projects,
    update: async ({ projectId, name }) => Object.assign(projects.find(({ id }) => id === projectId), { name }),
  } } });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const call = (method, input) => harness.behavior.callRpc(method, input);
  const move = (projectId, direction) => call("projectMove", { projectId, direction, baseline: projects.map(({ id }) => id) });
  await Promise.all([move("b", "up"), move("proj_personal", "up")]);
  assert.deepEqual(await call("projectOrder", null), ["b", "proj_personal", "a"]);
  ({ bb, harness } = await harness.lifecycle.reload(plugin));
  assert.deepEqual(await call("projectOrder", null), ["b", "proj_personal", "a"]);
  await call("projectRename", { projectId: "a", name: "  Новое имя  " });
  assert.equal(projects[0].name, "Новое имя");
  await assert.rejects(call("projectRename", { projectId: "a", name: " \n " }));
  await assert.rejects(call("projectRename", { projectId: "proj_personal", name: "Личное" }), /системный/);
  await assert.rejects(move("missing", "up"), /не найден/);
  assert.equal(harness.inspection.sdk.callsTo("projects.update").length, 1);
  assert.equal(harness.inspection.sdk.callsTo("projects.delete").length, 0);
  assert.equal(harness.inspection.sdk.callsTo("threads.delete").length, 0);
});

async function projectFixture(t) {
  const projects = ["a", "b", "c", "proj_personal"].map((id) => ({ id, name: id }));
  const threads = [];
  let host = createFakePluginHost({ sdk: {
    projects: {
      list: async () => projects,
      get: async ({ projectId }) => {
        const project = projects.find(({ id }) => id === projectId);
        if (!project) throw new Error("Проект не найден");
        return project;
      },
      delete: async ({ projectId }) => { projects.splice(projects.findIndex(({ id }) => id === projectId), 1); return { ok: true }; },
    },
    threads: { list: async ({ projectId, archived, includeHidden, limit }) => threads.filter((thread) =>
      thread.projectId === projectId && !!thread.archivedAt === archived && (includeHidden || thread.visibility !== "hidden")).slice(0, limit) },
  } });
  t.after(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);
  return {
    projects, threads,
    call: (method, input) => host.harness.behavior.callRpc(method, input),
    reload: async () => { host = await host.harness.lifecycle.reload(plugin); },
    harness: () => host.harness,
  };
}

test("archived hidden chats keep the native project and cards; Personal grouping and restore survive reload", async (t) => {
  const f = await projectFixture(t);
  f.threads.push({ id: "hidden", projectId: "a", archivedAt: 1, visibility: "hidden" });
  const card = await f.call("issueCreate", { projectId: "a", status: "todo", test: true });
  const preview = await f.call("projectRemovalPreview", { projectId: "a" });
  assert.equal(preview.mode, "personal");
  await f.call("projectRemove", { projectId: "a", confirmation: preview.confirmation });
  assert.deepEqual(await f.call("projectPersonalGroups", null), ["a"]);
  assert.deepEqual(await f.call("issueList", null), [card]);
  assert.ok(f.projects.some(({ id }) => id === "a"));
  assert.equal(f.harness().inspection.sdk.callsTo("projects.delete").length, 0);
  assert.equal(f.harness().inspection.sdk.callsTo("threads.delete").length, 0);
  await f.reload();
  assert.deepEqual(await f.call("projectPersonalGroups", null), ["a"]);
  await f.call("projectRestore", { projectId: "a" });
  await f.reload();
  assert.deepEqual(await f.call("projectPersonalGroups", null), []);
  assert.deepEqual(await f.call("issueList", null), [card]);
});

test("no chats deletes only the selected project, preserving its tasks and hierarchy in Personal", async (t) => {
  const f = await projectFixture(t);
  const parent = await f.call("issueCreate", { projectId: "a", status: "backlog", test: true });
  const child = await f.call("issueCreate", { projectId: "a", status: "todo", parentId: parent.id, test: true });
  const other = await f.call("issueCreate", { projectId: "b", status: "todo", test: true });
  const preview = await f.call("projectRemovalPreview", { projectId: "a" });
  assert.equal(preview.mode, "delete");
  assert.equal(preview.tasks, 2);
  await f.call("projectRemove", { projectId: "a", confirmation: preview.confirmation });
  assert.deepEqual(f.harness().inspection.sdk.callsTo("projects.delete"), [[{ projectId: "a" }]]);
  assert.equal(f.projects.some(({ id }) => id === "a"), false);
  const cards = await f.call("issueList", null);
  for (const original of [parent, child]) {
    const current = cards.find(({ id }) => id === original.id);
    assert.deepEqual(current, { ...original, projectId: "proj_personal", version: original.version + 1, updatedAt: current.updatedAt });
  }
  assert.deepEqual(cards.find(({ id }) => id === other.id), other);
  await f.reload();
  assert.equal((await f.call("issueList", null)).find(({ id }) => id === child.id).projectId, "proj_personal");
});

test("a fresh chat or changed task invalidates a deletion confirmation; native failures preserve tasks", async (t) => {
  const f = await projectFixture(t);
  const card = await f.call("issueCreate", { projectId: "a", status: "todo", test: true });
  const preview = await f.call("projectRemovalPreview", { projectId: "a" });
  f.threads.push({ id: "new", projectId: "a", archivedAt: null, visibility: "visible" });
  await assert.rejects(f.call("projectRemove", { projectId: "a", confirmation: preview.confirmation }), /изменились/);
  assert.equal(f.harness().inspection.sdk.callsTo("projects.delete").length, 0);
  assert.deepEqual(await f.call("projectPersonalGroups", null), []);
  f.threads.length = 0;
  f.harness().sdk.stub("projects.delete", async () => { throw new Error("Сбой удаления"); });
  await assert.rejects(f.call("projectRemove", { projectId: "a", confirmation: preview.confirmation }), /Сбой удаления/);
  assert.deepEqual(await f.call("issueList", null), [card]);
  await f.call("issueMove", { id: card.id, status: "backlog" }); // project lock was released
  await assert.rejects(f.call("projectRemove", { projectId: "a", confirmation: preview.confirmation }), /изменились/);
  await assert.rejects(f.call("projectRemovalPreview", { projectId: "proj_personal" }), /системный/);
});

test("moving projects skips groups in Personal and moving tasks within Personal keeps native ownership", async (t) => {
  const f = await projectFixture(t);
  f.threads.push({ id: "exists", projectId: "b", archivedAt: null });
  const preview = await f.call("projectRemovalPreview", { projectId: "b" });
  await f.call("projectRemove", { projectId: "b", confirmation: preview.confirmation });
  const order = await f.call("projectMove", { projectId: "a", direction: "down", baseline: ["a", "b", "c", "proj_personal"] });
  assert.deepEqual(order, ["c", "b", "a", "proj_personal"]);
  const source = await f.call("issueCreate", { projectId: "b", status: "backlog", test: true });
  const target = await f.call("issueCreate", { projectId: "proj_personal", status: "todo", test: true });
  const moved = await f.call("issueMove", { id: source.id, status: "todo", beforeId: target.id });
  assert.equal(moved.projectId, "b");
  assert.equal(moved.status, "todo");
  assert.equal(moved.order, 0);
  const unrelated = await f.call("issueCreate", { projectId: "a", status: "todo", test: true });
  await assert.rejects(f.call("issueMove", { id: moved.id, status: "todo", beforeId: unrelated.id }), /позиция/);
});
