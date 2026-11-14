import type { PluginSidebarThread } from '@get-bb/plugin-sdk/app';

export type ActivityEvent = { seq: number; createdAt: number; type: string; data: Record<string, unknown> };
export type ActivitySample = { label: string; seq: number; at: number; phase: 'active' | 'done' | 'error' | 'stopped'; startedAt?: number | null };
export type CardState = 'working' | 'waiting' | 'error' | 'done' | 'idle';
export type CardPresentation = { state: CardState; label: string; hint: string; threadId?: string };
export type ActivityThread = Pick<PluginSidebarThread, 'id' | 'isArchived' | 'hasPendingInteraction' | 'activity' | 'updatedAt'> &
  { status: string; runtimeStatus: string; queuedWork: string };
type Thread = ActivityThread;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

export function isAgentWorking(thread: Thread) {
  return !thread.isArchived && (['active', 'starting', 'stopping', 'provisioning', 'waiting-for-host'].includes(thread.runtimeStatus) ||
    thread.queuedWork === 'waiting' || Object.values(thread.activity).some(count => count > 0));
}

/** Closed vocabulary: raw tool names, commands, paths and reasoning never become UI text. */
export function toolActivity(item: Record<string, unknown>): string {
  const args = object(item.arguments);
  const tool = String(item.tool ?? item.name ?? '').split(/[.:/]/).at(-1)!.replace(/^mcp__.*?__/, '').toLowerCase();
  if (item.type === 'reasoning') return 'Думаю…';
  if (item.type === 'agentMessage') return 'Пишу ответ…';
  if (item.type === 'fileRead' || ['read_file', 'read_text_file', 'read_multiple_files', 'get_file_contents'].includes(tool)) return 'Читаю содержимое файла';
  if (item.type === 'fileChange' || ['apply_patch', 'edit_file', 'replace_text', 'str_replace'].includes(tool)) {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const patch = String(args.patch ?? args.input ?? '');
    return (changes.length > 0 && changes.every(change => object(change).kind === 'add')) ||
      (patch.includes('*** Add File:') && !/\*\*\* (Update|Delete) File:/.test(patch)) ? 'Записываю новый файл' : 'Изменяю файлы';
  }
  if (['write_file', 'create_file'].includes(tool)) return 'Записываю новый файл';
  if (item.type === 'search' || ['rg', 'grep', 'search_files', 'list_directory', 'glob'].includes(tool)) return 'Ищу в файлах';
  if (item.type === 'webSearch' || /^(web_?search|search_query|web__run)$/.test(tool)) return 'Ищу информацию в интернете';
  if (item.type === 'webFetch' || ['fetch', 'open_url'].includes(tool)) return 'Читаю страницу';
  if (item.type === 'imageView' || tool === 'view_image') return 'Рассматриваю изображение';
  if (/imagegen|generate_image/.test(tool)) return 'Создаю изображение';
  if (item.type === 'commandExecution' || ['exec_command', 'run_command', 'shell', 'bash', 'powershell'].includes(tool)) {
    const raw = String(item.command ?? args.cmd ?? args.command ?? '').trim();
    // Codex records the shell launcher as well as the command on Windows.
    const command = (raw.match(/^(?:"[^"]*(?:powershell|pwsh)(?:\.exe)"|(?:powershell|pwsh)(?:\.exe))\s+(?:-NoProfile\s+)?-Command\s+(["'])([\s\S]*)\1$/i)?.[2] ??
      raw.match(/^(?:"[^\"]*(?:bash|zsh)"|(?:bash|zsh))\s+-[lc]+\s+(["'])([\s\S]*)\1$/i)?.[2] ?? raw).trim();
    // A mixed shell script is deliberately left generic; it may read AND write.
    if (!/[;\n]|&&|\|\|/.test(command)) {
      if (/^(?:Get-Content|cat|head|tail|type)\s/i.test(command)) return 'Читаю содержимое файла';
      if (/^New-Item\b.*-ItemType\s+['"]?File\b/i.test(command)) return 'Записываю новый файл';
      if (/^(?:Set-Content|Add-Content|Out-File)\b/i.test(command)) return 'Записываю файл';
      if (/^(?:rg|grep|findstr|Select-String|Get-ChildItem|ls|dir)\b/i.test(command)) return 'Ищу в файлах';
      if (/^(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck)\b|^node\s+--test\b|^pytest\b|^tsc\b/i.test(command)) return 'Проверяю изменения';
      if (/^(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b|^bb\s+plugin\s+build\b/i.test(command)) return 'Собираю проект';
    }
    return 'Выполняю команду';
  }
  if (['request_user_input', 'request_user_input_async'].includes(tool)) return 'Ожидаю вашего ответа';
  if (['wait', 'write_stdin', 'sleep'].includes(tool)) return 'Ожидаю результат';
  if (item.type === 'plan' || tool === 'update_plan') return 'Составляю план';
  return 'Выполняю действие…';
}

/** Rebuild from a bounded ordered event window. Completed items cannot remain current. */
export function activityFromEvents(events: readonly ActivityEvent[]): ActivitySample {
  const pending = new Map<string, { label: string; seq: number; type: string }>();
  let phase: ActivitySample['phase'] = 'active', seq = 0, at = 0;
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    seq = event.seq; at = event.createdAt;
    if (['client/turn/requested', 'turn/started'].includes(event.type)) { pending.clear(); phase = 'active'; }
    else if (event.type === 'turn/completed' || event.type === 'system/thread/interrupted') {
      pending.clear();
      phase = event.type === 'system/thread/interrupted' || event.data.status === 'interrupted' ? 'stopped' :
        event.data.status === 'failed' ? 'error' : 'done';
    } else if (['item/started', 'item/toolCall/progress', 'item/mcpToolCall/progress', 'item/completed'].includes(event.type)) {
      const item = object(event.data.item), id = String(item.id ?? '');
      if (!id || item.type === 'userMessage') continue;
      if (event.type === 'item/completed' || ['completed', 'failed', 'interrupted'].includes(String(item.status))) pending.delete(id);
      else if (phase === 'active') pending.set(id, { label: toolActivity(item), seq, type: String(item.type) });
    }
  }
  const active = [...pending.values()].sort((a, b) => b.seq - a.seq);
  const tool = active.find(item => !['reasoning', 'agentMessage'].includes(item.type));
  return { seq, at, phase, label: phase === 'active' ? (tool ?? active[0])?.label ?? 'Думаю…' :
    phase === 'error' ? 'Работа прервана' : phase === 'stopped' ? 'Работа остановлена' : 'Работа завершена' };
}

export function cardPresentation(threads: readonly Thread[], samples: Readonly<Record<string, ActivitySample>>,
  task: { status?: string; error?: string | null; busy?: string; blocked?: boolean; hasLinkedChats?: boolean } = {}): CardPresentation {
  const available = threads.filter(thread => !thread.isArchived);
  const waiting = available.find(thread => thread.hasPendingInteraction);
  if (waiting) return { state: 'waiting', label: 'Ожидаю вашего ответа', hint: 'Агент ожидает ответа или разрешения', threadId: waiting.id };
  const working = available.filter(isAgentWorking).sort((a, b) => b.updatedAt - a.updatedAt);
  const current = working[0];
  if (current) {
    const sample = samples[current.id];
    const label = current.runtimeStatus === 'waiting-for-host' ? 'Ожидаю подключения машины' :
      current.runtimeStatus === 'provisioning' ? 'Подготавливаю окружение…' :
      current.runtimeStatus === 'starting' ? 'Запускаюсь…' : current.runtimeStatus === 'stopping' ? 'Останавливаюсь…' :
      current.queuedWork === 'waiting' && current.runtimeStatus === 'idle' ? 'Сообщение в очереди' :
      current.activity.workflows ? 'Выполняю рабочий процесс' : current.activity.backgroundAgents ? 'Работают фоновые агенты' :
      current.activity.backgroundCommands ? 'Выполняю фоновую команду' : current.activity.planMode ? 'Составляю план' :
      sample?.phase === 'active' ? sample.label : sample?.phase === 'error' ? 'Работа прервана' :
      sample?.phase === 'done' || sample?.phase === 'stopped' ? sample.label : 'Получаю текущее действие…';
    const extra = working.length > 1 ? ` · ещё ${working.length - 1} чат в работе` : '';
    const state = sample?.phase === 'error' ? 'error' : sample && sample.phase !== 'active' && working.length === 1 ? 'done' : 'working';
    return { state, label: label + extra,
      hint: (state === 'error' ? 'Ошибка агента' : state === 'done' ? label : 'Агент работает') + extra, threadId: current.id };
  }
  const failed = threads.find(thread => thread.status === 'error' || thread.queuedWork === 'failed');
  if (task.error || failed) return { state: 'error', label: 'Работа прервана', hint: task.error || 'Ошибка агента', threadId: failed?.id };
  if (task.busy) return { state: 'working', label: task.busy === 'planning' ? 'Готовлю план…' : 'Подготавливаю запуск…', hint: 'Подготовка задачи' };
  if (task.blocked) return { state: 'waiting', label: 'Ожидает другую задачу', hint: 'Задача заблокирована зависимостью' };
  if (!threads.length && task.hasLinkedChats) return { state: 'idle', label: 'Получаю состояние чата…', hint: 'Состояние связанного чата ещё не загружено' };
  const done = threads.length > 0 || ['review', 'done', 'cancelled'].includes(task.status ?? '');
  return { state: done ? 'done' : 'idle', label: task.status === 'cancelled' ? 'Работа отменена' : done ? 'Работа завершена' : 'Готово к запуску',
    hint: done ? 'Агент завершил работу' : 'Агент не запущен' };
}
