import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const archiveChanged = "chat-archive-changed";
export const threadArchiveTag = (threadId: string) => `chat-archive:${threadId}`;

export const archiveRpc = defineRpcContract({
  archiveParents: {
    input: z.null(),
    output: z.record(z.string(), z.string()),
  },
  archivedThreads: {
    input: z.object({ keys: z.array(z.string().min(1)).min(1).max(200) }),
    output: z.record(z.string(), z.string().nullable()),
    keyTags: (threadId) => [threadArchiveTag(threadId)],
  },
  archiveChat: {
    input: z.object({ threadId: z.string().min(1), archived: z.boolean() }),
    output: z.null(),
  },
});
