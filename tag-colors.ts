import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { isTestTag, testTag } from './planning';

const tagName = z.string().trim().min(1).max(40);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const tagColor = z.object({ tag: tagName, color });
export type TagColors = Readonly<Record<string, string>>;
export const tagColorKey = (tag: string) => isTestTag(tag) ? testTag : tag;
export const defaultTagColor = (tag: string) => isTestTag(tag) ? '#facc15' : '#94a3b8';
export function colorForTag(tag: string, colors: TagColors) {
  const key = tagColorKey(tag);
  return Object.hasOwn(colors, key) ? colors[key] : defaultTagColor(tag);
}

export const tagColorsChanged = 'tag-colors-changed';
export const tagColorsRpc = defineRpcContract({
  tagColorsRead: { input: z.null(), output: z.array(tagColor) },
  tagColorsSave: {
    input: z.array(z.object({ tag: tagName, color: color.nullable() })).min(1).max(12),
    output: z.array(tagColor),
  },
});
