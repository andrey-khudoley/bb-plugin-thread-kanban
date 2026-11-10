import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { paneHeaders, windowPlacement } from "./window-placement";

const id = z.string().min(1).max(512);
export const preferenceSchema = z.object({
  providerId: id, model: id,
  reasoningLevel: id.optional(), serviceTier: id.optional(),
});
export type Preference = z.infer<typeof preferenceSchema>;
export const changed = "kanban-settings-changed";
export const contract = defineRpcContract({
  read: { input: z.null(), output: preferenceSchema.nullable() },
  save: { input: preferenceSchema.nullable(), output: preferenceSchema.nullable() },
});
export const settingsSchema = z.object({
  preference: preferenceSchema.nullable(), windowPlacement, paneHeaders,
});
export type Settings = z.infer<typeof settingsSchema>;
export { paneHeaders, defaultPaneHeaders, windowPlacement, windowPlacementChanged, windowPlacementContract } from "./window-placement";
