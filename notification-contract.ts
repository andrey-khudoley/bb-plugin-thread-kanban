import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const noticeSchema = z.object({
  id: z.string(), threadId: z.string(), title: z.string(),
  kind: z.enum(['completed', 'question']), detail: z.string(),
  createdAt: z.number(), readAt: z.number().nullable(),
});
export type Notice = z.infer<typeof noticeSchema>;
export const channel = 'notifications-changed';
export const soundChannel = 'sound-arrival';
export const testNotificationChannel = 'test-notification';
export const soundEventSchema = z.object({
  id: z.string().min(1).max(250),
  kind: z.enum(['completed', 'question', 'error', 'derivation', 'test']),
  threadId: z.string().nullable(), at: z.number(),
});
export type SoundEvent = z.infer<typeof soundEventSchema>;
export const systemChannelSchema = z.enum(['web', 'desktop']).nullable();
export const soundDecisionSchema = z.object({
  play: z.boolean(), reason: z.enum(['play', 'disabled', 'expired', 'claimed', 'cooldown', 'system', 'missing']),
});
export const contract = defineRpcContract({
  'notifications.sound.test': { input: z.object({}), output: z.object({ ok: z.boolean(), id: z.string() }) },
  'notifications.sound.setEnabled': { input: z.object({ enabled: z.boolean() }), output: z.object({ enabled: z.boolean() }) },
  'notifications.sound.presence': { input: z.object({ clientId: z.string().min(1).max(100), systemChannel: systemChannelSchema }), output: z.object({ ok: z.boolean() }) },
  'notifications.sound.claim': { input: z.object({ id: z.string().min(1).max(250) }), output: soundDecisionSchema },
  'notifications.sound.contribute': { input: z.object({ id: z.string().min(1).max(250).startsWith('derivation:') }), output: z.object({ ok: z.boolean() }) },
  'notifications.list': { input: z.object({}), output: z.object({ notices: noticeSchema.array(), unread: z.number(), coveredThreads: z.string().array(), hiddenLegacyThreads: z.string().array() }) },
  'notifications.read': { input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) },
  'notifications.viewThread': { input: z.object({ threadId: z.string().min(1).max(100) }), output: z.object({ ok: z.boolean() }) },
  'notifications.dismiss': { input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) },
  'notifications.dismissAll': { input: z.object({ legacyThreadIds: z.array(z.string().min(1).max(100)).max(10000) }), output: z.object({ ok: z.boolean() }) },
  'notifications.dismissLegacy': { input: z.object({ threadId: z.string().min(1).max(100) }), output: z.object({ ok: z.boolean() }) },
});
