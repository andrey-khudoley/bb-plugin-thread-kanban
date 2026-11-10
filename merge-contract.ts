import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { gitSha as sha, workGitCommit, workSnapshot } from "./work-diff-contract";

const id = z.string().min(1).max(150);
const path = z.string().min(1).max(16000);
export const worktreeState = z.enum(["empty", "pending", "dirty", "merged", "unavailable"]);
const changes = z.object({ files: z.array(path).max(200), count: z.number().int().nonnegative() });
export const checkoutCommit = z.object({ head: sha, subject: z.string() });
export const sharedReviewResult = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ready"), commit: checkoutCommit.nullable() }),
  z.object({ outcome: z.literal("blocked"), revision: sha, paths: z.array(path), message: z.string() }),
]);
export const sharedReviewResolution = z.object({
  revision: sha, task: z.array(path).max(200), foreign: z.array(path).max(200),
  patch: z.string().min(1).max(120_000).optional(),
});
const waiter = z.object({ id, title: z.string(), reason: z.enum(["working", "input", "queued"]) });
const candidate = z.object({ id, path: path.nullable(), branch: z.string().max(1024).nullable() });
const snapshot = z.object({
  id, state: worktreeState, branch: z.string().nullable(), head: sha.nullable(),
  files: z.array(z.string()).max(80), message: z.string(),
  changes: changes.optional(),
});
const preparation = changes.extend({
  id, kind: z.enum(["worktree", "main"]), title: z.string(), branch: z.string(), commitAvailable: z.boolean(),
  waitingFor: z.array(waiter).optional(),
});
export type MergePreparation = z.infer<typeof preparation>;
const result = z.object({ project: z.string(), head: sha.nullable(), message: z.string() });
const conflictId = z.string().regex(/^[0-9a-f]{64}$/);
export const resolution = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().max(36000) }),
  z.object({ kind: z.literal("current") }),
  z.object({ kind: z.literal("incoming") }),
]);
const conflictSide = z.object({ exists: z.boolean(), mode: z.string().nullable(), text: z.string().nullable() });
const conflict = z.object({
  id: conflictId, path, branch: z.string(), text: z.boolean(),
  base: conflictSide, current: conflictSide, incoming: conflictSide,
});
const mergeInput = z.object({
  root: path, base: sha,
  candidates: z.array(candidate.extend({ head: sha })).min(1).max(200),
  resolutions: z.record(conflictId, resolution).default({}),
});
const conflicting = z.object({ outcome: z.literal("conflict"), conflicts: z.array(conflict).min(1).max(6) });
export type MergeConflict = z.infer<typeof conflict>;
export type Resolution = z.infer<typeof resolution>;
export const hasConflictMarkers = (text: string) => /^(?:<{7,}|>{7,}|\|{7,})(?:\s|$)/m.test(text);
const scope = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("single"), threadId: id }),
  z.object({ mode: z.literal("all"), projectId: id.optional() }),
  z.object({ mode: z.literal("selected"), issueIds: z.array(id).max(200), threadIds: z.array(id).max(200) }),
]);
export type MergeScope = z.infer<typeof scope>;

export const mergeHostRpc = defineRpcContract({
  readGitHistory: {
    input: z.object({
      path, base: sha.nullable(), head: sha.nullable(), branch: z.string().nullable(),
      shared: z.object({
        threadId: id, dirtyPaths: z.array(path).nullable(),
        evidence: z.array(z.object({ startedAt: z.number(), before: z.number().nullable(), files: workSnapshot.shape.files })),
      }).optional(),
    }),
    output: z.array(workGitCommit),
    experimental_retryable: true,
  },
  readGitCommitPatch: {
    input: z.object({ path, sha, parent: sha, files: z.array(z.string()).nullable() }),
    output: workSnapshot.shape.files,
    experimental_retryable: true,
  },
  sharedWorkOrigin: {
    input: z.object({ path }),
    output: z.object({ base: sha, branch: z.string(), dirtyPaths: z.array(path).nullable() }).nullable(),
    experimental_retryable: true,
  },
  readSharedWorkDiff: {
    input: z.object({
      path, branch: z.string().nullable(), threadId: id, startedAt: z.number(), base: sha.nullable(),
      dirtyPaths: z.array(path).nullable(),
      run: z.object({ startedAt: z.number(), endedAt: z.number().nullable() }).optional(),
      edits: z.array(z.object({ path, kind: z.enum(["add", "delete", "update"]), diff: z.string(), at: z.number(),
        beforeRun: z.literal(true).optional() })),
    }),
    output: z.union([workSnapshot, z.object({ reason: z.string() })]).nullable(),
    experimental_retryable: true,
  },
  readWorkDiff: {
    input: z.object({
      checkout: path.nullable(), root: path.nullable(), branch: z.string().min(1), createdAt: z.number(),
      base: sha.nullable(), head: sha.nullable(), mergedAt: sha.nullable(),
      knownHead: sha.optional(), revisionsOnly: z.literal(true).optional(),
    }),
    output: workSnapshot.nullable(),
    experimental_retryable: true,
  },
  inspectCheckout: {
    input: z.object({ path }),
    output: z.object({ dirty: z.boolean() }),
    experimental_retryable: true,
  },
  commitCheckout: {
    input: z.object({ path, title: z.string().max(1200), expectedHead: sha.nullable().optional(),
      expectedBranch: z.string().optional(), expectedFiles: z.array(path).max(200).optional() }),
    output: checkoutCommit.nullable(),
  },
  reviewSharedCheckout: {
    input: z.object({ path, title: z.string().max(1200), expectedHead: sha.nullable(), expectedBranch: z.string(),
      threadId: id, snapshot: workSnapshot.nullable(), latest: workSnapshot.optional(),
      committed: z.array(workGitCommit).default([]),
      requireFull: z.boolean().optional(),
      resolution: sharedReviewResolution.optional(),
    }),
    output: sharedReviewResult,
  },
  inspectWorktrees: {
    input: z.object({ root: path, candidates: z.array(candidate).max(200), includeFiles: z.boolean() }),
    output: z.object({ base: sha, candidates: z.array(snapshot), mainChanges: changes.optional(), mainIssue: z.string().optional() }),
    experimental_retryable: true,
  },
  mergeWorktrees: {
    input: mergeInput,
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("merged"), head: sha }),
      conflicting,
    ]),
  },
  previewMergeConflicts: {
    input: mergeInput,
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("previewed") }),
      conflicting,
    ]),
  },
});

const mergePlan = z.object({
  id,
  state: z.enum(["planning", "blocked", "ready", "merging", "resolving", "awaiting", "done", "failed"]),
  title: z.string().default(""),
  waitingFor: z.array(waiter).optional(),
  preparations: z.array(preparation).default([]),
  commits: z.array(z.object({ branch: z.string(), head: z.string(), subject: z.string() })).default([]),
  branches: z.array(z.object({ id, project: z.string(), title: z.string(), branch: z.string(), head: sha })),
  skipped: z.array(z.object({ title: z.string(), message: z.string() })),
  message: z.string(),
  results: z.array(result),
  questions: z.array(z.object({
    id: conflictId, path, branch: z.string(), question: z.string(),
    choices: z.array(z.object({ id, label: z.string(), description: z.string() })),
    previews: z.object({ current: z.string().nullable(), incoming: z.string().nullable() }).optional(),
    explained: z.boolean().optional(),
  })).default([]),
  explaining: z.boolean().optional(),
  resolved: z.array(z.object({ path, branch: z.string(), by: z.enum(["agent", "user"]), message: z.string() })).default([]),
});
export type MergePlan = z.infer<typeof mergePlan>;
export const worktreeChanged = "worktree-merge-changed";
export const mergeRpc = defineRpcContract({
  worktreeStates: {
    input: z.object({ keys: z.array(id).min(1).max(200) }),
    output: z.record(id, z.object({ state: worktreeState, branch: z.string().nullable(), message: z.string() }).nullable()),
  },
  planMerge: { input: scope, output: mergePlan },
  mergeStatus: { input: z.object({ id }), output: mergePlan },
  mergeHistory: { input: z.null(), output: z.array(mergePlan) },
  refreshMerge: { input: z.object({ id }), output: mergePlan },
  retryMerge: { input: z.object({ id }), output: mergePlan },
  dismissMerge: { input: z.object({ id }), output: z.null() },
  commitMergeChanges: { input: z.object({ id, preparationId: id }), output: mergePlan },
  applyMerge: { input: z.object({ id }), output: mergePlan },
  explainMerge: { input: z.object({ id }), output: mergePlan },
  answerMerge: {
    input: z.object({ id, answers: z.array(z.object({ questionId: conflictId, choiceId: id })).min(1).max(6) }),
    output: mergePlan,
  },
});
