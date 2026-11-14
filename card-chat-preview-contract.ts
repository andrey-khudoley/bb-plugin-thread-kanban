import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const cardChatPreviewRpc = defineRpcContract({
  cardChatPreview: { input: z.object({ threadId: z.string().min(1).max(160) }),
    output: z.object({ threadId: z.string(), lines: z.array(z.object({ key: z.string(),
      role: z.enum(['user', 'assistant']), text: z.string().max(600) })).max(8) }) },
});
