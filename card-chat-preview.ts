import type { BbPluginApi } from '@get-bb/plugin-sdk';
type TimelineResult = Awaited<ReturnType<BbPluginApi['sdk']['threads']['timeline']>>;
export type PreviewTimelineRow = Extract<TimelineResult, { rows: unknown[] }>['rows'][number];
type TimelineRow = PreviewTimelineRow;

export type ChatPreviewLine = { key: string; role: 'user' | 'assistant'; text: string };

function plainLine(source: string) {
  const line = source.slice(0, 8000).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  if (/^(?:`{3,}|~{3,})/.test(line) || (/^[|\s:-]+$/.test(line) && /-{3}/.test(line))) return '';
  return line.replace(/(!?)\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g,
    (_match, image: string, label: string) => label || (image ? 'Изображение' : 'Ссылка'))
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2').replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/, '').replace(/^\|\s*|\s*\|$/g, '').replace(/\s+\|\s+/g, ' · ').trim();
}

/** Only the visible dialogue: tool output, reasoning and injected agent messages stay out. */
export function chatPreviewLines(rows: readonly TimelineRow[]): ChatPreviewLine[] {
  const messages = new Map<string, Extract<TimelineRow, { kind: 'conversation' }>>();
  function collect(items: readonly TimelineRow[]) {
    for (const row of items) {
      if (row.kind === 'turn') collect(row.children ?? []);
      else if (row.kind === 'conversation' && (row.role === 'user' || row.role === 'assistant')) {
        if (row.role === 'user' && (row.senderThreadId || (row.systemMessageKind && row.systemMessageKind !== 'unlabeled'))) continue;
        const previous = messages.get(row.id);
        if (!previous || row.sourceSeqEnd >= previous.sourceSeqEnd) messages.set(row.id, row);
      }
    }
  }
  collect(rows);
  const ordered = [...messages.values()].sort((a, b) => a.sourceSeqStart - b.sourceSeqStart);
  const result: ChatPreviewLine[] = [];
  for (let i = ordered.length - 1; i >= 0 && result.length < 8; i--) {
    const message = ordered[i];
    const lines = message.text.replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, '').split(/\r?\n/);
    for (let n = lines.length - 1; n >= 0 && result.length < 8; n--) {
      const text = plainLine(lines[n]);
      if (text) result.push({ key: `${message.id}:${n}`, role: message.role, text: text.slice(0, 600) });
    }
  }
  return result.reverse();
}
