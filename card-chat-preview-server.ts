import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { cardChatPreviewRpc } from './card-chat-preview-contract';
import { chatPreviewLines, type PreviewTimelineRow } from './card-chat-preview';

export function registerCardChatPreview(bb: BbPluginApi) {
  bb.rpc.register(cardChatPreviewRpc, {
    async cardChatPreview({ threadId }) {
      const rows: PreviewTimelineRow[] = [];
      let cursor: { anchorId: string; anchorSeq: number } | undefined;
      // Fetch only on hover. Busy tool-only segments may require an older page.
      for (let page = 0; page < 4; page++) {
        const response = await bb.sdk.threads.timeline({ threadId, segmentLimit: '8', includeNestedRows: 'true',
          ...(cursor ? { beforeAnchorId: cursor.anchorId, beforeAnchorSeq: String(cursor.anchorSeq) } : {}) });
        rows.push(...response.rows);
        const lines = chatPreviewLines(rows);
        const older = response.timelinePage.olderCursor;
        if (lines.length === 8 || !older || older.anchorId === cursor?.anchorId) return { threadId, lines };
        cursor = older;
      }
      return { threadId, lines: chatPreviewLines(rows) };
    },
  });
}
