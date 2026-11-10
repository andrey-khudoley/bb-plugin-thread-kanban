import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { planSchema } from "./planning";
import { checkoutCommit } from "./merge-contract";
import { executionSelection, launchOptions } from "./launch-settings";

export const personalProjectId = "proj_personal";

export const issueStages = [
  { id: "backlog", label: "Бэклог", dot: "bg-muted-foreground" },
  { id: "todo", label: "К выполнению", dot: "bg-indigo-500" },
  { id: "working", label: "В работе", dot: "bg-blue-500" },
  { id: "review", label: "На проверке", dot: "bg-amber-500" },
  { id: "done", label: "Завершён", dot: "bg-emerald-500" },
  { id: "cancelled", label: "Отменён", dot: "bg-rose-500" },
] as const;
export const issueStatus = z.enum(["backlog", "todo", "working", "review", "done", "cancelled"]);
export const initialIssueStatus = z.enum(["backlog", "todo"]);
export type IssueStatus = z.infer<typeof issueStatus>;
const id = z.string().min(1).max(100);
export const contextFragment = z.object({
  label: z.string().min(1).max(160),
  text: z.string().trim().min(1).max(2000),
});
export const deriveMode = z.enum(["single", "decompose"]);
export const suggestionSchema = z.object({
  title: z.string().trim().min(1).max(180),
  plan: z.string().trim().min(1).max(12000),
  reply: z.string().trim().min(1).max(4000),
});
export const fieldsSchema = planSchema.extend({
  title: z.string().trim().max(180),
  description: z.string().max(12000).default(""),
  assignee: z.string().trim().max(120),
  parentId: id.nullable(),
  blockedBy: z.array(id).max(50),
  related: z.array(id).max(50),
  duplicateOf: id.nullable(),
  autoTitle: z.boolean(),
  autoPlan: z.boolean(),
  executionPrompt: z.string().max(12000).default(""),
  context: z.array(contextFragment).max(8).default([]),
});
const message = z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(12000) });
const operation = z.object({
  kind: z.enum(["planning", "start", "review"]),
  token: id,
  at: z.number(),
  threadId: id.optional(),
});
export const issueSchema = fieldsSchema.extend({
  id, projectId: id, status: issueStatus,
  threadIds: z.array(id),
  messages: z.array(message),
  order: z.number(), createdAt: z.number(), updatedAt: z.number(), version: z.number(),
  busy: operation.nullable(),
  error: z.string().nullable(),
  reviewWorker: id.nullable().optional(),
  origin: z.object({ mode: deriveMode, issueId: id, threadId: id.nullable() }).nullable().default(null),
});
export type Issue = z.infer<typeof issueSchema>;
export type IssueFields = z.infer<typeof fieldsSchema>;
export const issuesChanged = "issues-changed";

const deriveSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("issue"), id }),
  z.object({ kind: z.literal("thread"), id }),
]);
export type DeriveSource = z.infer<typeof deriveSource>;
export type DeriveMode = z.infer<typeof deriveMode>;
const deriveRequest = z.object({
  source: deriveSource, mode: deriveMode, instruction: z.string().trim().max(6000).default(""), test: z.boolean().optional(),
})
  .refine(({ mode, instruction }) => mode === "decompose" || !!instruction, { message: "Опиши, что нужно сделать." });
export type DeriveRequest = z.infer<typeof deriveRequest>;
const deriveResult = z.object({
  id, status: z.enum(["running", "done", "failed"]), parentId: id.nullable(),
  children: z.array(issueSchema), message: z.string(),
  phase: z.enum(["context", "starting", "waiting", "checking", "saving"]).default("context"),
  agentStarted: z.boolean().default(false),
  activity: z.array(z.string()).default([]),
});
export type DeriveResult = z.infer<typeof deriveResult>;

export const derivationRpc = defineRpcContract({
  deriveTasks: { input: deriveRequest, output: deriveResult },
  derivationStatus: { input: z.object({ id }), output: deriveResult },
});

export const issueReviewInput = z.object({ id, threadId: id, environmentId: id,
  expectedHead: checkoutCommit.shape.head.nullable(), expectedBranch: z.string().min(1) });

export const issueRpc = defineRpcContract({
  issueList: { input: z.null(), output: z.array(issueSchema) },
  issueCreate: {
    input: z.object({ projectId: id, status: issueStatus, parentId: id.optional(), threadId: id.optional(), test: z.boolean().optional() }).refine(
      ({ status, threadId }) => initialIssueStatus.safeParse(status).success ||
        (threadId !== undefined && (status === "working" || status === "done")),
      { path: ["status"], message: "Новая задача создаётся в «Бэклоге» или «К выполнению»." },
    ),
    output: issueSchema,
  },
  issueSave: {
    input: z.object({ id, version: z.number(), fields: fieldsSchema }),
    output: issueSchema,
  },
  issueMove: {
    input: z.object({ id, status: issueStatus, beforeId: id.optional(), atEnd: z.boolean().optional() }), output: issueSchema,
  },
  issueMoveMany: {
    input: z.object({ ids: z.array(id).min(1).max(200), status: issueStatus }),
    output: z.object({ moved: z.number() }),
  },
  issueReview: {
    input: issueReviewInput,
    output: z.object({ issue: issueSchema, commit: checkoutCommit.nullable(), remaining: z.number().int().nonnegative(),
      blocked: z.boolean().optional() }),
  },
  issueAsk: {
    input: z.object({ id, text: z.string().trim().min(1).max(12000) }), output: issueSchema,
  },
  issueStart: {
    input: executionSelection.extend({
      id, providerId: id.optional(), worktree: z.boolean(), sourceThreadId: id.optional(),
    }),
    output: z.object({ issue: issueSchema, threadId: id }),
  },
  issueLaunchOptions: {
    input: z.object({ id, providerId: id.optional(), worktree: z.boolean() }), output: launchOptions,
  },
  issueLink: {
    input: z.object({ id, threadId: id, linked: z.boolean() }), output: issueSchema,
  },
  issueDeletePreview: {
    input: z.object({ id }),
    output: z.object({ confirmation: z.string(), chats: z.number(), worktrees: z.number(), warnings: z.array(z.string()) }),
  },
  issueDelete: { input: z.object({ id, confirmation: z.string() }), output: z.object({ deleted: z.boolean() }) },
});
