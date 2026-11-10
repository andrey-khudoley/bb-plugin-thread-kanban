type Change = { kind: string; path: string };

export function commitMessage(title: string, changes: Change[], merge = false) {
  const cleaned = title.replace(/\s+/g, " ").trim();
  const explicit = /^(fix|dev|feat|docs|test|chore|refactor|perf|build|ci|style|revert):\s*(.+)$/i.exec(cleaned);
  const summary = explicit?.[2] ?? (cleaned || "Обновить рабочую копию");
  const prefix = merge ? "merge" : explicit?.[1].toLowerCase()
    ?? (changes.length && changes.every(({ path }) => /(?:^|\/)docs\/|\.(?:md|rst|adoc)$/i.test(path)) ? "docs"
      : changes.length && changes.every(({ path }) => /(?:^|\/)tests?\/|\.(?:test|spec)\.[^/]+$/i.test(path)) ? "test"
        : /\b(?:fix|bug|repair)\b|исправ|ошибк|сбо[йя]|регресси/i.test(summary) ? "fix" : "dev");
  const limit = 72 - prefix.length - 2;
  const clipped = summary.length <= limit ? summary : summary.slice(0, limit - 1).replace(/\s+\S+$/, "").trimEnd() + "…";
  const verbs: Record<string, string> = { A: "Добавить", M: "Обновить", D: "Удалить", T: "Изменить тип" };
  const bullets = changes.map(({ kind, path }) => {
    const name = /[\x00-\x1f\x7f]/.test(path) ? JSON.stringify(path) : path;
    return `- ${verbs[kind] ?? "Изменить"} ${name}`;
  });
  return { subject: `${prefix}: ${clipped}`, body: bullets.join("\n") || "- Объединить историю ветки" };
}
