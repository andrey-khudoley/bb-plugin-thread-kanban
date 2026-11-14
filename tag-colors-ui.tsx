import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { experimental_useRpcQuery, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import { colorForTag, defaultTagColor, tagColorKey, tagColorsChanged, tagColorsRpc, type TagColors } from './tag-colors';
import { Button } from './components/ui/button';

const TagColorsContext = createContext<TagColors>({});
export const useTagColors = () => useContext(TagColorsContext);
function useTagColorQuery() {
  const query = experimental_useRpcQuery({ contract: tagColorsRpc, method: 'tagColorsRead', input: null });
  useRealtime(tagColorsChanged, () => void query.refetch());
  const colors = useMemo(() => Object.fromEntries((query.data ?? []).map(({ tag, color }) => [tag, color])), [query.data]);
  return { ...query, colors };
}
export function TagColorsProvider({ children }: { children: ReactNode }) {
  const query = useTagColorQuery();
  return <TagColorsContext.Provider value={query.colors}>{children}</TagColorsContext.Provider>;
}

/** A separate row keeps tags clear of the title, status and card menu. */
export function CardTagDots({ tags }: { tags: readonly string[] }) {
  const colors = useTagColors();
  if (!tags.length) return null;
  const groups = new Map<string, string[]>();
  for (const tag of tags) {
    const color = colorForTag(tag, colors).toLowerCase();
    const names = groups.get(color);
    if (names) names.push(tag);
    else groups.set(color, [tag]);
  }
  return <div className="kb-card-tag-dots" role="list" aria-label="Цвета тегов карточки">
    {[...groups].map(([color, names]) => <span key={color} role="listitem" className="kb-card-tag-dot"
      title={names.join(', ')} aria-label={names.join(', ')} style={{ backgroundColor: color }} />)}
  </div>;
}

export function TagColorEditor({ tags }: { tags: readonly string[] }) {
  const query = useTagColorQuery();
  const rpc = useRpc<typeof tagColorsRpc>();
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const names = [...new Set(tags.map(tag => tag.trim()).filter(Boolean).map(tagColorKey))].slice(0, 12);
  if (!names.length) return null;
  const colors = query.colors;
  const changes = names.filter(tag => Object.hasOwn(draft, tag) &&
    (draft[tag] === null ? Object.hasOwn(colors, tag) : draft[tag] !== colorForTag(tag, colors)))
    .map(tag => ({ tag, color: draft[tag] }));
  return <details className="kb-tag-color-editor">
    <summary>Цвета тегов</summary>
    <p>Цвет тега общий для всех карточек.</p>
    <fieldset disabled={busy || query.isLoading || !!query.error}>
      <div className="kb-tag-color-options">
        {names.map(tag => <div className="kb-tag-color-option" key={tag}>
          <label><input type="color" aria-label={`Цвет тега ${tag}`}
            value={Object.hasOwn(draft, tag) ? draft[tag] ?? defaultTagColor(tag) : colorForTag(tag, colors)}
            onChange={event => { setDraft(previous => ({ ...previous, [tag]: event.target.value })); setError(''); }} />
            <span>{tag}</span></label>
          <button type="button" className="text-muted-foreground" aria-label={`Сбросить цвет тега ${tag}`}
            onClick={() => { setDraft(previous => ({ ...previous, [tag]: null })); setError(''); }}>Сбросить</button>
        </div>)}
      </div>
      <Button type="button" size="sm" variant="outline" disabled={!changes.length} onClick={async () => {
        if (busy || !changes.length) return;
        setBusy(true); setError('');
        try {
          await rpc.call('tagColorsSave', changes);
          setDraft({});
          await query.refetch();
        } catch { setError('Не удалось сохранить цвета тегов. Попробуй ещё раз.'); }
        finally { setBusy(false); }
      }}>{busy ? 'Сохраняю…' : 'Сохранить цвета'}</Button>
    </fieldset>
    {(error || query.error) && <p role="alert">{error || 'Не удалось загрузить цвета тегов.'}</p>}
    {!!query.error && <button type="button" onClick={() => void query.refetch()}>Повторить загрузку цветов</button>}
  </details>;
}
