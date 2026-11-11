import type { PluginSidebarThread } from '@get-bb/plugin-sdk/app';
function stageOf(thread: PluginSidebarThread) {
  if (thread.isArchived) return 'done';
  if (thread.hasPendingInteraction) return 'waiting';
  if (['active', 'starting', 'stopping', 'provisioning', 'waiting-for-host'].includes(thread.runtimeStatus) ||
    thread.queuedWork === 'waiting' || Object.values(thread.activity).some(count => count > 0)) return 'working';
  return thread.status === 'pending' ? 'new' : 'done';
}

/** Count server threads, never panes or tab instances. Include hidden work, as the board's live source does. */
export function statusThreads(threads: readonly PluginSidebarThread[]) {
  const unique = new Map<string, PluginSidebarThread>();
  for (const thread of threads) {
    const previous = unique.get(thread.id);
    if (!previous || thread.updatedAt >= previous.updatedAt) unique.set(thread.id, thread);
  }
  const all = [...unique.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const active = all.filter(thread => !thread.isArchived);
  return {
    all,
    working: active.filter(thread => stageOf(thread) === 'working'),
    waiting: active.filter(thread => stageOf(thread) === 'waiting'),
    notifications: active.filter(thread => thread.isUnread && stageOf(thread) === 'done'),
  };
}

export function chatStatusText(thread: PluginSidebarThread) {
  if (thread.hasPendingInteraction) return 'Ожидает вашего ответа или разрешения';
  if (thread.runtimeStatus === 'waiting-for-host') return 'Ожидает подключения машины';
  if (thread.runtimeStatus === 'provisioning') return 'Подготавливает окружение';
  if (thread.runtimeStatus === 'starting') return 'Запускает агента';
  if (thread.runtimeStatus === 'stopping') return 'Останавливает агента';
  if (stageOf(thread) === 'working') {
    if (thread.queuedWork === 'waiting' && thread.runtimeStatus === 'idle') return 'Сообщение в очереди';
    if (thread.activity.workflows) return 'Выполняет workflow';
    if (thread.activity.backgroundAgents) return 'Работают фоновые агенты';
    if (thread.activity.backgroundCommands) return 'Выполняет фоновую команду';
    if (thread.activity.planMode) return 'Готовит план';
    return 'Агент работает';
  }
  return thread.status === 'error' || thread.queuedWork === 'failed' ? 'Работа прервана с ошибкой' : 'Работа завершена';
}
