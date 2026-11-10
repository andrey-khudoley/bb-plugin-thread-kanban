type NativeTab = { key: string; title: string };
type Label = {
  key: string; nativeTitle: string; node: Text; originalText: string; shown: string;
  button: HTMLElement; originalTitle: string | null;
  tooltip: HTMLElement | null; originalTooltip: string | null;
  close: HTMLElement | null; originalClose: string | null;
};

/** Decorate only native text/accessible labels; leave the elements and handlers intact. */
export function createTabLabels() {
  const labels = new Map<HTMLElement, Label>();
  function release(pill: HTMLElement) {
    const label = labels.get(pill);
    if (!label) return;
    if (label.node.data === label.shown) label.node.data = label.originalText;
    if (label.button.getAttribute('title') === label.shown) {
      if (label.originalTitle === null) label.button.removeAttribute('title');
      else label.button.setAttribute('title', label.originalTitle);
    }
    if (label.tooltip?.getAttribute('title') === label.shown) {
      if (label.originalTooltip === null) label.tooltip.removeAttribute('title');
      else label.tooltip.setAttribute('title', label.originalTooltip);
    }
    if (label.close?.getAttribute('aria-label') === `Close ${label.shown}`) {
      if (label.originalClose === null) label.close.removeAttribute('aria-label');
      else label.close.setAttribute('aria-label', label.originalClose);
    }
    labels.delete(pill);
  }
  return {
    resolve<T extends NativeTab>(pill: HTMLElement, tabs: readonly T[], fallback: () => T | null): T | null {
      const label = labels.get(pill);
      if (label && pill.contains(label.node)) {
        const tab = tabs.find((tab) => tab.key === label.key && tab.title === label.nativeTitle);
        if (tab) return tab;
      }
      release(pill);
      return fallback();
    },
    show(pill: HTMLElement, tab: NativeTab, title: string) {
      let label = labels.get(pill);
      if (label && (label.key !== tab.key || !pill.contains(label.node))) { release(pill); label = undefined; }
      if (!label) {
        const button = pill.querySelector<HTMLElement>('button[aria-pressed]');
        if (!button) return;
        const walker = pill.ownerDocument.createTreeWalker(button, 4); // SHOW_TEXT
        const candidates: Text[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.nodeValue?.trim() === tab.title) candidates.push(node as Text);
        }
        if (candidates.length !== 1) return;
        const node = candidates[0];
        const tooltip = node.parentElement?.hasAttribute('title') ? node.parentElement : null;
        const close = pill.querySelector<HTMLElement>('[data-tab-pill-close]');
        label = { key: tab.key, nativeTitle: tab.title, node, originalText: node.data, shown: node.data,
          tooltip, originalTooltip: tooltip?.getAttribute('title') ?? null,
          button, originalTitle: button.getAttribute('title'), close, originalClose: close?.getAttribute('aria-label') ?? null };
        labels.set(pill, label);
      }
      label.shown = title;
      if (label.node.data !== title) label.node.data = title;
      if (label.button.getAttribute('title') !== title) label.button.setAttribute('title', title);
      if (label.tooltip && label.tooltip.getAttribute('title') !== title) label.tooltip.setAttribute('title', title);
      if (label.close && label.close.getAttribute('aria-label') !== `Close ${title}`) label.close.setAttribute('aria-label', `Close ${title}`);
    },
    retain(pills: ReadonlySet<HTMLElement>) { for (const pill of labels.keys()) if (!pills.has(pill)) release(pill); },
    clear() { for (const pill of labels.keys()) release(pill); },
  };
}
