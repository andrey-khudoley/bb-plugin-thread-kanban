/** Shared geometry for column headings and compact stage selectors. */
export function StageHeading({ label, count, folded = false }: {
  label: string;
  count: number;
  folded?: boolean;
}) {
  return <>
    {!folded && <span className="kb-stage-name" title={label}>{label}</span>}
    <span className="kb-stage-count" title={`Карточек: ${count}`} aria-label={`Карточек ${count}`}>{count}</span>
  </>;
}
