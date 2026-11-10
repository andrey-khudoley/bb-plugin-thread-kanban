import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ExperimentalPanelController } from "@get-bb/plugin-sdk/app";

// Shared by the board, integrated settings UI and settings storage.
export const windowPlacement = z.enum(["right", "below", "above"]);
export type WindowPlacement = z.infer<typeof windowPlacement>;
export const paneHeaders = z.object({ top: z.boolean(), bottom: z.boolean() });
export type PaneHeaders = z.infer<typeof paneHeaders>;
export const defaultPaneHeaders: PaneHeaders = { top: false, bottom: true };
export const windowPlacementChanged = "kanban-window-placement-changed";
export const windowPlacementContract = defineRpcContract({
  readWindowPlacement: { input: z.null(), output: windowPlacement },
  saveWindowPlacement: { input: windowPlacement, output: windowPlacement },
  readPaneHeaders: { input: z.null(), output: paneHeaders },
  savePaneHeaders: { input: paneHeaders, output: paneHeaders },
});

const opening = new Map<ExperimentalPanelController, Set<() => void>>();
export function onKanbanPanelOpen(panel: ExperimentalPanelController, apply: () => void) {
  const listeners = opening.get(panel) ?? new Set<() => void>();
  opening.set(panel, listeners); listeners.add(apply);
  return () => { listeners.delete(apply); if (!listeners.size) opening.delete(panel); };
}
export function prepareKanbanPanel(panel: ExperimentalPanelController) {
  const target = panel.getTabs();
  // Different useAppPanel hook instances wrap the same native controller.
  for (const [owner, listeners] of opening) {
    const current = owner.getTabs();
    if (owner === panel || (current.selectedKey === target.selectedKey && current.tabs.length === target.tabs.length
      && current.tabs.every((tab, index) => tab.key === target.tabs[index].key))) listeners.forEach((apply) => apply());
  }
}
