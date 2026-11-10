import { useId, type ReactNode } from "react";

/** The native tab strip owns back/close/split. Content headings own identity and actions. */
export function PanelHeading({ title, context, status, actions, standalone = false }: {
  title: string; context: string; status?: ReactNode; actions?: ReactNode; standalone?: boolean;
}) {
  const contextId = useId();
  return <div className={`kb-detail-head kb-detail-heading${standalone ? " kb-mobile-workspace-heading kb-standalone-heading" : ""}`}>
    <div className="kb-panel-identity">
      <h2 className="kb-detail-title kb-detail-text kb-scroll-title"
        title={`${title}\n${context}`} aria-describedby={contextId}>{title}</h2>
      <span id={contextId} className="kb-header-context" title={context}>{context}</span>
    </div>
    {(status || actions) && <div className="kb-panel-utility">
      {status && <div className="kb-panel-status">{status}</div>}
      {actions && <div className="kb-detail-actions" role="group" aria-label={standalone ? "Действия с чатом" : "Действия с задачей"}>{actions}</div>}
    </div>}
  </div>;
}
