import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { experimental_useRpcKeyedQuery, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { mergeRpc, worktreeChanged, type MergeScope } from "./merge-contract";
import type { z } from "zod";

export type WorktreeStatus = z.infer<typeof mergeRpc.worktreeStates.output>[string];
export type WorktreeStatuses = Readonly<Record<string, WorktreeStatus>>;

export function useWorktreeStates(keys: string[]) {
  const query = experimental_useRpcKeyedQuery({ contract: mergeRpc, method: "worktreeStates", keys });
  const refresh = useRef(query.refetchKeys);
  refresh.current = query.refetchKeys;
  const ids = useRef(keys);
  ids.current = keys;
  useRealtime(worktreeChanged, () => { void refresh.current(ids.current).catch(() => {}); });
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden && ids.current.length) void refresh.current(ids.current).catch(() => {});
    }, 20000);
    return () => clearInterval(timer);
  }, []);
  return query.data ?? {};
}

export function WorktreeBadge({ status, branch }: { status?: WorktreeStatus; branch?: string | null }) {
  if (!status && !branch) return null;
  const label = status?.state === "merged" ? "В main" : "Worktree";
  const detail = [status?.branch ?? branch, status?.message,
    status?.state === "merged" ? "Метка подтверждает Git. Установленная версия проверяется в «Настройках канбана»." : null].filter(Boolean).join(" · ");
  return <span className={`kb-badge bg-muted ${label === "Worktree" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}
    title={detail || label}>{label}</span>;
}

export function useOpenMerge() {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof mergeRpc>();
  const pending = useRef(false);
  return async (scope: MergeScope) => {
    if (pending.current) return;
    pending.current = true;
    try {
      const { id } = await rpc.call("planMerge", scope);
      navigate.toPluginPanel("board", { subPath: `merges/${id}` });
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
    }
  };
}
