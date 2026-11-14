import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TagBadge } from './kanban-ui';
import { usePortalScopeProps } from './lib/portal-scope';
import { CardChatPreview } from './card-chat-preview-ui';

/** The portal clears clipping scroll containers and never participates in card geometry. */
export function useCardTags(tags: readonly string[], threadId?: string | null, chatCaption?: string) {
  const id = useId();
  const scope = usePortalScopeProps();
  const anchor = useRef<HTMLElement | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusFrame = useRef<number | undefined>(undefined);
  const menuOpen = useRef(false);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const [open, setOpen] = useState(false);
  const hasContent = tags.length > 0 || !!threadId;
  const cancel = () => {
    clearTimeout(timer.current); timer.current = undefined;
    if (focusFrame.current !== undefined) window.cancelAnimationFrame(focusFrame.current);
    focusFrame.current = undefined;
  };
  const close = () => { cancel(); setOpen(false); };
  const show = () => {
    if (!hasContent || !anchor.current || menuOpen.current) return;
    setOpen(true);
  };
  useLayoutEffect(() => {
    if (!open || !anchor.current || !popup.current) return;
    const update = () => {
      const card = anchor.current!.getBoundingClientRect(), box = popup.current!.getBoundingClientRect();
      const above = innerHeight - card.bottom < box.height + 18 && card.top > innerHeight - card.bottom;
      const left = Math.max(12, Math.min(card.left, innerWidth - box.width - 12));
      const top = Math.max(12, Math.min(above ? card.top - box.height - 6 : card.bottom + 6, innerHeight - box.height - 12));
      setPosition(previous => previous.left === left && previous.top === top ? previous : { left, top });
    };
    update();
    const observer = new ResizeObserver(update); observer.observe(popup.current);
    return () => observer.disconnect();
  }, [open]);
  useEffect(() => () => cancel(), []);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    const hide = (event: Event) => { if (!(event.target instanceof Element && event.target.closest('.kb-card-tags'))) close(); };
    window.addEventListener('keydown', escape, true);
    window.addEventListener('resize', hide);
    document.addEventListener('scroll', hide, true);
    return () => { window.removeEventListener('keydown', escape, true); window.removeEventListener('resize', hide); document.removeEventListener('scroll', hide, true); };
  }, [open]);
  return {
    onMenuOpenChange: (value: boolean) => { menuOpen.current = value; close(); },
    bindings: {
      ref: anchor, tabIndex: 0, 'aria-describedby': open && hasContent ? id : undefined,
      onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
        if (event.pointerType === 'touch' || !hasContent || menuOpen.current || !event.currentTarget.contains(event.target as Node) ||
          (event.target instanceof Element && event.target.closest('[aria-haspopup="menu"]'))) return;
        cancel(); timer.current = setTimeout(show, 600);
      },
      onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
        if (event.currentTarget.contains(event.target as Node) && event.target instanceof Element && event.target.closest('[aria-haspopup="menu"]')) close();
      },
      onPointerLeave: () => { cancel(); timer.current = setTimeout(() => setOpen(false), 160); },
      onFocus: (event: React.FocusEvent<HTMLElement>) => {
        // React portal focus bubbles through the card even though the menu is outside its DOM.
        if (menuOpen.current || !event.currentTarget.contains(event.target) || event.target.closest('[aria-haspopup="menu"]') ||
          !event.target.matches(':focus-visible') || event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        cancel();
        // Let the browser finish scrolling the newly focused card into view first.
        focusFrame.current = window.requestAnimationFrame(() => {
          focusFrame.current = window.requestAnimationFrame(() => { focusFrame.current = undefined; show(); });
        });
      },
      onBlur: (event: React.FocusEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(); },
      onPointerDown: close,
      onDragStartCapture: close,
    },
    tooltip: open && hasContent ? createPortal(<div {...scope} ref={popup} id={id} role="tooltip" className="kb-card-tags" data-chat-preview={!!threadId}
      style={position}
      onPointerEnter={cancel} onPointerLeave={close} onWheel={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
      {tags.length > 0 && <><div className="kb-card-tags-heading">Теги <span>{tags.length}</span></div>
        <div className="kb-card-tags-items">{tags.map(tag => <TagBadge key={tag} tag={tag} />)}</div></>}
      {threadId && <CardChatPreview key={threadId} threadId={threadId} caption={chatCaption} />}
    </div>, document.body) : null,
  };
}
