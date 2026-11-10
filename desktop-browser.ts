/**
 * Narrow, capability-checked adapter for BB desktop's existing BrowserView.
 * SDK 0.6.132 exposes discovery/close/subscribe, but no browser renderer.
 * Keep this desktop-only boundary separate from the public SDK integration.
 */
export type DesktopTarget = { hostId: string; instanceId: string; generation: string };
export type BrowserState = { tabId: string; url: string; title: string; isLoading: boolean; canGoBack?: boolean; canGoForward?: boolean; errorText?: string | null };
export type Bounds = { x: number; y: number; width: number; height: number };
export interface DesktopBrowser {
  getTarget(): Promise<DesktopTarget | null>;
  attach(input: { tabId: string; threadId: string; url: string; bounds: Bounds; visible: boolean; existingOnly: true }): void;
  setBounds(input: { tabId: string; bounds: Bounds }): void;
  setVisible(input: { tabId: string; visible: boolean }): void;
  setVisibleWithoutFocus?(input: { tabId: string; visible: boolean }): void;
  onState(listener: (state: BrowserState) => void): () => void;
  navigate(input: { tabId: string; url: string }): void;
  reload(tabId: string): void;
  goBack?(tabId: string): void;
  goForward?(tabId: string): void;
  releaseControl?(tabId: string): void;
  focus?(tabId: string): void;
}
export function desktopBrowser(): DesktopBrowser | null {
  const browser = (window as unknown as { bbDesktop?: { browser?: DesktopBrowser } }).bbDesktop?.browser;
  return browser && ['getTarget', 'attach', 'setBounds', 'setVisible', 'onState'].every(
    key => typeof browser[key as keyof DesktopBrowser] === 'function') ? browser : null;
}
export function browserBounds(element: HTMLElement): Bounds | null {
  if (!element.isConnected || !element.getClientRects().length || element.closest('[hidden],[aria-hidden="true"]')) return null;
  const rect = element.getBoundingClientRect();
  const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
  const width = Math.min(innerWidth, rect.right) - x, height = Math.min(innerHeight, rect.bottom) - y;
  return width > 0 && height > 0 ? { x: Math.round(x), y: Math.round(y), width: Math.floor(width), height: Math.floor(height) } : null;
}
