import { useEffect, useRef, useState, type FormEvent } from 'react';
import { UserAvatar } from './user-avatar';

type ApiCall = <T,>(path: string, init?: RequestInit) => Promise<T>;
type FeedItem = { id: string; activityId: string; activityTitle: string; kind: string; eventType: string; summary: string; actorSub: string; actorName: string; createdAt: string; taskId?: string; text?: string };
type Notification = { id: string; activityId: string; activityTitle: string; taskId: string; eventType: string; summary: string; actorName: string; createdAt: string; readAt: string | null; text?: string };
type Page<T> = { items: T[]; nextCursor: string | null };
type NotificationPage = Page<Notification> & { unreadCount: number };

const date = (value: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(new Date(value));
const message = (error: unknown) => error instanceof Error ? error.message : 'Не удалось загрузить данные.';

export function ActivityFeedPage({ api, manager, kams, onOpenActivity }: {
  api: ApiCall; manager: boolean; kams: { sub: string; name: string }[]; onOpenActivity: (id: string) => void;
}) {
  const [owner, setOwner] = useState('');
  const [items, setItems] = useState<FeedItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const requestVersion = useRef(0);
  useEffect(() => {
    let live = true;
    const currentVersion = ++requestVersion.current;
    setBusy(true); setError(''); setItems([]); setCursor(null);
    const query = new URLSearchParams({ limit: '30' });
    if (manager && owner) query.set('actorSub', owner);
    api<Page<FeedItem>>(`/api/feed?${query}`).then((page) => {
      if (live && currentVersion === requestVersion.current) { setItems(page.items); setCursor(page.nextCursor); }
    }).catch((reason) => { if (live && currentVersion === requestVersion.current) setError(message(reason)); })
      .finally(() => { if (live && currentVersion === requestVersion.current) setBusy(false); });
    return () => { live = false; requestVersion.current++; };
  }, [api, manager, owner, revision]);
  async function more() {
    if (!cursor || busy) return;
    const currentVersion = requestVersion.current;
    setBusy(true); setError('');
    const query = new URLSearchParams({ limit: '30', cursor });
    if (manager && owner) query.set('actorSub', owner);
    try {
      const page = await api<Page<FeedItem>>(`/api/feed?${query}`);
      if (currentVersion === requestVersion.current) { setItems((current) => [...current, ...page.items]); setCursor(page.nextCursor); }
    } catch (reason) { if (currentVersion === requestVersion.current) setError(message(reason)); }
    finally { if (currentVersion === requestVersion.current) setBusy(false); }
  }
  return <div className="activity-updates-page">
    <div className="page-heading"><div><div className="eyebrow">РАБОТА С КЛИЕНТАМИ</div><h1>{manager ? 'Движение команды' : 'Мои действия'}</h1><p>{manager ? 'Хронология действий КАМ по доступным активностям' : 'Ваши действия по доступным активностям'}</p></div><button className="secondary" onClick={() => { requestVersion.current++; setRevision((value) => value + 1); }}>Обновить</button></div>
    <section className="panel activity-updates-panel" aria-label="Лента действий">
      {manager && <label className="field activity-feed-filter"><span>Автор действия</span><select value={owner} onChange={(event) => { requestVersion.current++; setItems([]); setCursor(null); setOwner(event.target.value); }}><option value="">Вся команда</option>{kams.map((kam) => <option key={kam.sub} value={kam.sub}>{kam.name}</option>)}</select></label>}
      {error && <p className="activity-updates-error" role="alert">{error}</p>}
      {busy && items.length === 0 ? <p className="muted-copy">Загружаем действия…</p> : items.length === 0 ? <p className="muted-copy">Действий пока нет.</p> : <ol className="activity-update-list">{items.map((item) => <li key={item.id}><span className="activity-update-dot" aria-hidden="true"/><div className="activity-update-content"><div className="activity-update-heading"><b>{item.summary}</b><time dateTime={item.createdAt}>{date(item.createdAt)}</time></div>{item.text && <details className="activity-update-text"><summary>Текст обновления</summary><p>{item.text}</p></details>}<div className="activity-update-attribution"><UserAvatar name={item.actorName} className="activity-update-avatar" /><span>{item.actorName}</span></div><p className="activity-update-subject"><button type="button" className="activity-update-link" onClick={() => onOpenActivity(item.activityId)}>{item.activityTitle}</button></p></div></li>)}</ol>}
      {cursor && <button className="secondary" disabled={busy} onClick={() => void more()}>{busy ? 'Загружаем…' : 'Показать ещё'}</button>}
    </section>
  </div>;
}

export function NotificationsPage({ api, onOpenActivity, onRead }: { api: ApiCall; onOpenActivity: (id: string) => void; onRead?: (count: number) => void }) {
  const [items, setItems] = useState<Notification[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const requestVersion = useRef(0);
  useEffect(() => {
    let live = true;
    const currentVersion = ++requestVersion.current;
    setBusy(true); setError(''); setItems([]); setCursor(null);
    api<NotificationPage>('/api/notifications?limit=30').then((page) => {
      if (live && currentVersion === requestVersion.current) { setItems(page.items); setCursor(page.nextCursor); onRead?.(page.unreadCount); }
    }).catch((reason) => { if (live && currentVersion === requestVersion.current) setError(message(reason)); })
      .finally(() => { if (live && currentVersion === requestVersion.current) setBusy(false); });
    return () => { live = false; requestVersion.current++; };
  }, [api, revision]);
  async function more() {
    if (!cursor || busy) return;
    const currentVersion = requestVersion.current;
    setBusy(true); setError('');
    try {
      const page = await api<NotificationPage>(`/api/notifications?limit=30&cursor=${encodeURIComponent(cursor)}`);
      if (currentVersion === requestVersion.current) { setItems((current) => [...current, ...page.items]); setCursor(page.nextCursor); onRead?.(page.unreadCount); }
    } catch (reason) { if (currentVersion === requestVersion.current) setError(message(reason)); }
    finally { if (currentVersion === requestVersion.current) setBusy(false); }
  }
  async function open(item: Notification) {
    if (!item.readAt) {
      try {
        const result = await api<{ id: string; readAt: string }>(`/api/notifications/${item.id}/read`, { method: 'POST' });
        setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, readAt: result.readAt } : entry));
        api<NotificationPage>('/api/notifications?limit=1').then((refreshed) => onRead?.(refreshed.unreadCount)).catch(() => {});
      } catch (reason) { setError(message(reason)); return; }
    }
    onOpenActivity(item.activityId);
  }
  return <div className="activity-updates-page">
    <div className="page-heading"><div><div className="eyebrow">ПОДПИСКИ НА ЗАДАЧИ</div><h1>Уведомления</h1><p>Новые записи и завершения задач, на которые вы подписаны</p></div><button className="secondary" onClick={() => { requestVersion.current++; setRevision((value) => value + 1); }}>Обновить</button></div>
    <section className="panel activity-updates-panel" aria-label="Уведомления">
      {error && <p className="activity-updates-error" role="alert">{error}</p>}
      {busy && items.length === 0 ? <p className="muted-copy">Загружаем уведомления…</p> : items.length === 0 ? <p className="muted-copy">Новых уведомлений пока нет. Подпишитесь на задачу в карточке.</p> : <ol className="activity-update-list">{items.map((item) => <li key={item.id} className={item.readAt ? '' : 'is-unread'}><span className="activity-update-dot" aria-hidden="true"/><div><div className="activity-update-heading"><b>{item.summary}</b><time dateTime={item.createdAt}>{date(item.createdAt)}</time></div>{item.text && <details className="activity-update-text"><summary>Текст обновления</summary><p>{item.text}</p></details>}<p>{item.actorName} · {item.activityTitle}</p><button type="button" className="activity-update-link" onClick={() => void open(item)}>{item.readAt ? 'Открыть карточку' : 'Прочитать и открыть карточку'}</button></div></li>)}</ol>}
      {cursor && <button className="secondary" disabled={busy} onClick={() => void more()}>{busy ? 'Загружаем…' : 'Показать ещё'}</button>}
    </section>
  </div>;
}

export function TaskUpdates({ api, activityId, taskId, readOnly, onChanged, onDirtyChange }: { api: ApiCall; activityId: string; taskId: string; readOnly: boolean; onChanged: () => void; onDirtyChange: (section: string, dirty: boolean) => void }) {
  const [subscribed, setSubscribed] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const path = `/api/activities/${activityId}/tasks/${taskId}`;
  const dirtyKey = `task-update-${taskId}`;
  useEffect(() => {
    let live = true;
    api<{ subscribed: boolean }>(`${path}/subscription`).then((value) => { if (live) setSubscribed(value.subscribed); })
      .catch((reason) => { if (live) setError(message(reason)); });
    return () => { live = false; };
  }, [api, path]);
  async function toggle() {
    setBusy(true); setError('');
    try {
      const value = await api<{ subscribed: boolean }>(`${path}/subscription`, { method: subscribed ? 'DELETE' : 'PUT' });
      setSubscribed(value.subscribed);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || busy || readOnly) return;
    setBusy(true); setError('');
    try {
      await api(`${path}/updates`, { method: 'POST', body: JSON.stringify({ text: text.trim() }) });
      setText(''); onDirtyChange(dirtyKey, false); onChanged();
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  return <div className="task-updates"><button type="button" className="activity-update-link" disabled={busy} aria-pressed={subscribed} onClick={() => void toggle()}>{subscribed ? '✓ Вы подписаны' : 'Подписаться на обновления'}</button>{!readOnly && <form onSubmit={(event) => void submit(event)}><label className="field"><span>Обновление по задаче</span><textarea value={text} disabled={busy} maxLength={2000} rows={2} onChange={(event) => { setText(event.target.value); onDirtyChange(dirtyKey, Boolean(event.target.value.trim())); }} placeholder="Коротко: что изменилось и какой следующий шаг" /></label><button className="secondary" disabled={busy || !text.trim()}>Добавить в ленту</button></form>}{error && <p className="activity-updates-error" role="alert">{error}</p>}</div>;
}
