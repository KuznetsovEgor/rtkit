import './activity-detail-polish.css';

type TimelineEvent = { id: string; eventType: string; actorName: string; createdAt: string; details: Record<string, unknown> };
const dayFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });

function eventPresentation(type: string) {
  if (type === 'task_completed') return { label: 'Выполнено', icon: '✓', tone: 'done' };
  if (type.startsWith('task_')) return { label: 'Задача', icon: '✓', tone: 'task' };
  if (type === 'outcome_recorded' || type === 'closure_outcome_recorded') return { label: 'Контакт', icon: '↗', tone: 'contact' };
  if (type === 'stage_changed' || type === 'workflow_stage_migrated') return { label: 'Переход', icon: '→', tone: 'stage' };
  if (type.startsWith('document_') || type.startsWith('contract_license_')) return { label: 'Документ', icon: '▤', tone: 'document' };
  if (type === 'imported' || type.startsWith('import_')) return { label: 'Импорт', icon: '↓', tone: 'system' };
  return { label: 'Запись', icon: '·', tone: 'record' };
}

export function ActivityTimeline<T extends TimelineEvent>({ events, label }: { events: T[]; label: (event: T) => string }) {
  const renderEvents = (items: T[]) => <ol className="activity-event-list">{items.map((event, index) => {
    const date = new Date(event.createdAt);
    const day = dayFormat.format(date);
    const previousDay = index ? dayFormat.format(new Date(items[index - 1].createdAt)) : null;
    const presentation = eventPresentation(event.eventType);
    const notes = [...new Set([event.details?.note, event.details?.text].filter((value): value is string => typeof value === 'string' && Boolean(value.trim())))];
    return <li key={event.id}>
      {day !== previousDay && <div className="activity-event-day">{day}<span>МСК</span></div>}
      <article className={`activity-event event-${presentation.tone}`}>
        <span className="activity-event-icon" aria-hidden="true">{presentation.icon}</span>
        <div className="activity-event-body"><div className="activity-event-meta"><span className="activity-event-type">{presentation.label}</span><time dateTime={event.createdAt}>{timeFormat.format(date)}</time></div><h3>{label(event)}</h3>{notes.map((note) => <blockquote key={note}>{note}</blockquote>)}<p className="activity-event-author">{event.actorName}</p></div>
      </article>
    </li>;
  })}</ol>;
  return <div className="activity-history-content">
    {renderEvents(events.slice(0, 3))}
    {events.length > 3 && <details className="activity-history-more"><summary><span>Более ранние события <b>{events.length - 3}</b></span><span className="activity-disclosure-arrow" aria-hidden="true">⌄</span></summary>{renderEvents(events.slice(3))}</details>}
  </div>;
}
