import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const gitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const workSnapshot = z.object({
  base: gitSha, head: gitSha, branch: z.string(),
  files: z.array(z.object({ name: z.string(), patch: z.string() })),
  shared: z.literal(true).optional(),
});
export type WorkSnapshot = z.infer<typeof workSnapshot>;
export const workRun = z.object({ id: z.string(), startedAt: z.number(), endedAt: z.number().nullable() });
export type WorkRun = z.infer<typeof workRun>;
export const workDiffChanged = "kanban-work-diff-changed";
export const workGitCommit = z.object({
  sha: gitSha, parent: gitSha, committedAt: z.number(), subject: z.string(),
  source: z.enum(["branch", "thread", "matched"]),
  files: z.array(z.string()).nullable(),
  fileCount: z.number().int().optional(),
});
export type WorkGitCommit = z.infer<typeof workGitCommit>;
const gitHistoryInput = z.object({ threadId: z.string().min(1), environmentId: z.string().min(1).nullable() });

export const workDiffRpc = defineRpcContract({
  workGitHistory: {
    input: gitHistoryInput,
    output: z.object({ commits: z.array(workGitCommit), message: z.string().optional(),
      range: workSnapshot.pick({ base: true, head: true }).optional() }),
  },
  workGitPatch: {
    input: gitHistoryInput.extend({ sha: gitSha.nullable() }),
    output: z.object({ files: workSnapshot.shape.files, message: z.string().optional() }),
  },
  workDiff: {
    input: z.object({ threadId: z.string().min(1), environmentId: z.string().min(1).nullable(),
      runId: z.string().min(1).optional() }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("available"), snapshot: workSnapshot, saved: z.boolean(), runs: z.array(workRun).optional() }),
      z.object({ outcome: z.literal("unavailable"), message: z.string(), runs: z.array(workRun).optional() }),
      z.object({ outcome: z.literal("not_applicable") }),
    ]),
  },
});
export type WorkDiffResult = z.infer<typeof workDiffRpc.workDiff.output>;
