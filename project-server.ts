import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash } from "node:crypto";
import { moveProject, orderProjects } from "./project-order";
import { personalGroupsKey, projectRpc, projectsChanged } from "./projects";
import { personalProjectId } from "./issues";

const orderKey = "project-order";

export function registerProjects(bb: BbPluginApi, issues: {
  projectIssues: (projectId: string) => { id: string; version: number }[];
  prepareProjectRemoval: (projectId: string) => { commit: () => void; release: () => void };
}) {
  let queue: Promise<unknown> = Promise.resolve();
  const readOrder = async () => {
    const saved = await bb.storage.kv.get<unknown>(orderKey);
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
  };
  const readGroups = async () => {
    const saved = await bb.storage.kv.get<unknown>(personalGroupsKey);
    return Array.isArray(saved) ? [...new Set(saved.filter((id): id is string => typeof id === "string" && id !== personalProjectId))] : [];
  };
  function serialize<T>(run: () => Promise<T>) {
    const operation = queue.then(run);
    queue = operation.catch(() => {});
    return operation;
  }
  async function removalPlan(projectId: string) {
    if (projectId === personalProjectId) throw new Error("Personal — системный проект, его нельзя убрать.");
    const project = await bb.sdk.projects.get({ projectId });
    // A visible empty board is not evidence that archived/hidden chats are absent.
    const pages = await Promise.all([false, true].map((archived) => bb.sdk.threads.list({
      projectId, archived, includeHidden: true, limit: 1,
    })));
    const mode = pages.some((page) => page.length) ? "personal" as const : "delete" as const;
    const tasks = issues.projectIssues(projectId);
    const confirmation = createHash("sha256").update(JSON.stringify({
      projectId, name: project.name, mode, tasks: tasks.map(({ id, version }) => [id, version]).sort(),
    })).digest("hex");
    return { mode, name: project.name, tasks: tasks.length, confirmation };
  }
  bb.rpc.register(projectRpc, {
    projectOrder: readOrder,
    projectPersonalGroups: readGroups,
    projectRemovalPreview: ({ projectId }) => removalPlan(projectId),
    projectRemove({ projectId, confirmation }) {
      return serialize(async () => {
        const plan = await removalPlan(projectId);
        if (confirmation !== plan.confirmation) throw new Error("Состав или название проекта изменились. Проверь условия ещё раз.");
        if (plan.mode === "personal") {
          await bb.storage.kv.set(personalGroupsKey, [...new Set([...await readGroups(), projectId])]);
        } else {
          const prepared = issues.prepareProjectRemoval(projectId);
          try {
            // Recheck immediately before the native destructive call, after acquiring the task lock.
            const current = await removalPlan(projectId);
            if (current.confirmation !== confirmation) throw new Error("Состав проекта изменился. Проверь условия ещё раз.");
            await bb.sdk.projects.delete({ projectId });
            prepared.commit();
          } finally {
            prepared.release();
          }
          await bb.storage.kv.set(personalGroupsKey, (await readGroups()).filter((id) => id !== projectId));
        }
        bb.realtime.publish(projectsChanged, null);
        return { mode: plan.mode };
      });
    },
    projectRestore({ projectId }) {
      return serialize(async () => {
        await bb.storage.kv.set(personalGroupsKey, (await readGroups()).filter((id) => id !== projectId));
        bb.realtime.publish(projectsChanged, null);
        return null;
      });
    },
    projectMove(input) {
      // Serialize read/modify/write so different open boards do not lose moves.
      return serialize(async () => {
        const projects = await bb.sdk.projects.list({ includePersonal: true });
        if (!projects.some(({ id }) => id === input.projectId)) throw new Error("Проект не найден.");
        const baseline = orderProjects(projects, input.baseline);
        const ordered = orderProjects(baseline, await readOrder()).map(({ id }) => id);
        const hidden = new Set(await readGroups());
        if (hidden.has(input.projectId)) throw new Error("Проект показан в Personal. Сначала верни его в канбан.");
        const visible = moveProject(ordered.filter((id) => !hidden.has(id)), input.projectId, input.direction);
        let position = 0;
        const next = ordered.map((id) => hidden.has(id) ? id : visible[position++]);
        await bb.storage.kv.set(orderKey, next);
        bb.realtime.publish(projectsChanged, null);
        return next;
      });
    },
    async projectRename({ projectId, name }) {
      if (projectId === personalProjectId) throw new Error("Personal — системный проект, его нельзя переименовать.");
      await bb.sdk.projects.update({ projectId, name });
      bb.realtime.publish(projectsChanged, null);
      return null;
    },
  });
}
