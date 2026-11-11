import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { emptyPlan, planChanged, planRpc, planSchema } from "./planning";
import { registerIssues } from "./issue-server";
import { registerMerges } from "./merge-server";
import { registerChatArchive } from "./chat-archive-server";
import { registerWorkDiffs } from "./work-diff-server";
import { registerAgentAccess } from "./agent-server";
import { reviewToolName } from "./review-agent";
import { registerProjects } from "./project-server";
import { registerSettings } from "./settings-server";
import { registerNotifications } from './notification-server';

export default function threadKanban(bb: BbPluginApi) {
  registerSettings(bb);
  registerNotifications(bb);
  const workDiffs = registerWorkDiffs(bb);
  const issues = registerIssues(bb, workDiffs, (ids) => merges.inspectEnvironments(ids, false));
  registerProjects(bb, issues);
  const merges = registerMerges(bb, workDiffs);
  registerChatArchive(bb);
  const readTools = registerAgentAccess(bb, issues);
  bb.agents.configure(({ origin, pluginMetadata }) => ({
    tools: [...readTools, ...(origin.pluginId === bb.pluginId && pluginMetadata.sharedReview === true ? [reviewToolName] : [])],
    skills: ["thread-kanban"],
    instructions: "Проверяй канбан через kanban_snapshot, kanban_card_get и kanban_diagnostics. " +
      "Для проверки отображения используй kanban_ui_snapshot; серверные данные не доказывают видимость. " +
      "Для скриншота открой вкладку через kanban_ui_open, затем kanban_ui_capture и закрой kanban_ui_close. " +
      "Вкладка наблюдения показывает настоящее приложение BB с отдельными настройками отображения; не выдавай её за окно пользователя.",
  }));
  bb.rpc.register(planRpc, {
    async planList({ keys }) {
      const rows = await bb.sdk.threads.experimental_listPluginMetadata({ threadIds: keys });
      const saved = new Map(rows.threads.map((row) => [row.threadId, row.metadata]));
      return Object.fromEntries(keys.map((id) => [
        id, planSchema.safeParse(saved.get(id) ?? {}).data ?? emptyPlan,
      ]));
    },
    async planSave({ threadId, plan }) {
      await bb.sdk.threads.updatePluginMetadata({ threadId, set: plan });
      bb.realtime.publish(planChanged, { threadId });
      return plan;
    },
  });
}
