import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { tagColorKey, tagColorsChanged, tagColorsRpc } from './tag-colors';
import { kanbanDatabase } from './database';

export function registerTagColors(bb: BbPluginApi) {
  const db = kanbanDatabase(bb);
  const scan = db.prepare('SELECT tag, color FROM kanban_tag_colors ORDER BY tag');
  const save = db.prepare('INSERT INTO kanban_tag_colors (tag, color) VALUES (?, ?) ON CONFLICT(tag) DO UPDATE SET color=excluded.color');
  const remove = db.prepare('DELETE FROM kanban_tag_colors WHERE tag=?');
  const read = () => scan.all() as { tag: string; color: string }[];
  bb.rpc.register(tagColorsRpc, {
    tagColorsRead: read,
    tagColorsSave(changes) {
      db.transaction(() => {
        for (const { tag, color } of changes) {
          if (color === null) remove.run(tagColorKey(tag));
          else save.run(tagColorKey(tag), color.toLowerCase());
        }
      })();
      bb.realtime.publish(tagColorsChanged, {});
      return read();
    },
  }, { experimental_discoverable: true, experimental_description: 'Shared tag colors; null resets a tag to its default color' });
}
