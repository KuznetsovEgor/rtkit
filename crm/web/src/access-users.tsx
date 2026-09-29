import { useEffect, useRef, useState } from 'react';
import { OrganizationScopeEditor, type OrganizationScopeUser } from './organization-scope';
import { formatRussianCount } from './russian-count';
import { UserAvatar } from './user-avatar';
import './access-users.css';

type ApiCall = <T,>(path: string, init?: RequestInit) => Promise<T>;
type AccessUser = {
  sub: string;
  name: string;
  roles: string[];
  enabled: boolean;
  lastSeenAt: string | null;
  updatedAt: string | null;
  updatedBySub: string | null;
  reason: string | null;
  allowedKinds: Array<'university' | 'corporate' | 'individual'> | null;
  scopeRevision: number;
  allowedOrganizationIds: string[] | null;
};
type AccessUsersResponse = { users: AccessUser[] };
type AccessChange = { enabled: boolean; reason: string };

const roleLabels: Record<string, string> = { admin: 'Администратор', manager: 'Руководитель', kam: 'КАМ' };
const kindLabels = { university: 'Вузы', corporate: 'Компании', individual: 'Физлица' } as const;
const allKinds = Object.keys(kindLabels) as Array<keyof typeof kindLabels>;

function messageOf(reason: unknown) {
  return reason instanceof Error ? reason.message : 'Не удалось выполнить действие.';
}

function formatDate(value: string | null) {
  if (!value) return 'Нет данных';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Нет данных';
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function AccessUsers({ api, currentUserSub }: { api: ApiCall; currentUserSub?: string }) {
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [editingSub, setEditingSub] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busySub, setBusySub] = useState<string | null>(null);
  const [scopeSub, setScopeSub] = useState<string | null>(null);
  const [scopeKinds, setScopeKinds] = useState<Array<keyof typeof kindLabels>>([]);
  const [scopeReason, setScopeReason] = useState('');
  const [organizationSub, setOrganizationSub] = useState<string | null>(null);
  const accessUserCards = useRef(new Map<string, HTMLElement>());

  function focusUserAction(sub: string, action: 'scope' | 'organizations' | 'access') {
    requestAnimationFrame(() => accessUserCards.current.get(sub)
      ?.querySelector<HTMLButtonElement>(`[data-access-action="${action}"]`)?.focus());
  }

  function focusUserEditor(sub: string) {
    requestAnimationFrame(() => {
      const editor = accessUserCards.current.get(sub)?.querySelector<HTMLElement>('.access-user-confirm, .organization-scope-editor');
      editor?.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])')?.focus();
    });
  }

  async function refreshUsers() {
    setLoading(true);
    setLoadError('');
    setActionError('');
    try {
      const result = await api<AccessUsersResponse>('/api/admin/access/users');
      setUsers(result.users);
    } catch (error) {
      setLoadError(messageOf(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refreshUsers(); }, [api]);

  function beginChange(user: AccessUser) {
    setScopeSub(null);
    setOrganizationSub(null);
    setEditingSub(user.sub);
    setReason('');
    setConfirmed(false);
    setActionError('');
    focusUserEditor(user.sub);
  }

  function cancelChange(focusSub?: string) {
    setEditingSub(null);
    setReason('');
    setConfirmed(false);
    setActionError('');
    if (focusSub) focusUserAction(focusSub, 'access');
  }

  function beginScope(user: AccessUser) {
    cancelChange();
    setOrganizationSub(null);
    setScopeSub(user.sub);
    setScopeKinds(user.allowedKinds ?? allKinds);
    setScopeReason('');
    focusUserEditor(user.sub);
  }

  function organizationSaved(updated: OrganizationScopeUser) {
    setUsers((current) => current.map((entry) => entry.sub === updated.sub ? { ...entry, ...updated } : entry));
    setOrganizationSub(null);
    focusUserAction(updated.sub, 'organizations');
    if (updated.sub === currentUserSub) window.location.reload();
  }

  async function saveScope(user: AccessUser) {
    if (!scopeReason.trim() || busySub) return;
    setBusySub(user.sub);
    setActionError('');
    try {
      const updated = await api<AccessUser>(`/api/admin/access/users/${encodeURIComponent(user.sub)}/scope`, {
        method: 'PUT', body: JSON.stringify({ allowedKinds: scopeKinds.length === allKinds.length ? null : scopeKinds, expectedRevision: user.scopeRevision, reason: scopeReason.trim() }),
      });
      setUsers((current) => current.map((entry) => entry.sub === updated.sub ? updated : entry));
      setScopeSub(null);
      setScopeReason('');
      focusUserAction(user.sub, 'scope');
      if (updated.sub === currentUserSub) window.location.reload();
    } catch (error) {
      if (error instanceof Error && 'status' in error && error.status === 409) {
        await refreshUsers();
        setScopeSub(null);
        setActionError('Область доступа изменилась. Список обновлён — откройте настройку заново.');
        focusUserAction(user.sub, 'scope');
        return;
      }
      setActionError(messageOf(error));
    } finally {
      setBusySub(null);
    }
  }

  async function saveChange(user: AccessUser) {
    const trimmedReason = reason.trim();
    if (!trimmedReason || !confirmed || busySub) return;
    const change: AccessChange = { enabled: !user.enabled, reason: trimmedReason };
    setBusySub(user.sub);
    setActionError('');
    try {
      const updated = await api<AccessUser>(`/api/admin/access/users/${encodeURIComponent(user.sub)}`, {
        method: 'PUT', body: JSON.stringify(change),
      });
      setUsers((current) => current.map((entry) => entry.sub === updated.sub ? updated : entry));
      cancelChange(user.sub);
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setBusySub(null);
    }
  }

  return <div className="access-users-page">
    <div className="page-heading access-users-heading">
      <div><div className="eyebrow">АДМИНИСТРИРОВАНИЕ · ДОСТУП</div><h1>Пользователи CRM</h1><p>Управление доступом известных пользователей. Роли поступают из Keycloak и здесь не редактируются.</p></div>
      <button className="secondary" type="button" disabled={loading || busySub !== null} onClick={() => void refreshUsers()}>↻ <span>Обновить список</span></button>
    </div>

    {loadError && <div className="access-users-alert" role="alert"><div><b>Не удалось загрузить пользователей</b><span>{loadError}</span></div><button className="secondary" type="button" onClick={() => void refreshUsers()}>Повторить</button></div>}
    {actionError && <div className="access-users-alert" role="alert"><div><b>Не удалось изменить доступ</b><span>{actionError}</span></div><button className="text-button" type="button" onClick={() => setActionError('')} aria-label="Закрыть сообщение">Закрыть</button></div>}

    <section className="panel access-users-panel" aria-labelledby="access-users-list-title" aria-busy={loading}>
      <div className="section-top"><div><div className="eyebrow">УЧЁТНЫЕ ЗАПИСИ</div><h2 id="access-users-list-title">Доступ в CRM</h2></div>{!loading && !loadError && <span className="access-users-count">{formatRussianCount(users.length, 'пользователь', 'пользователя', 'пользователей')}</span>}</div>
      {loading ? <div className="access-users-state" role="status"><span className="access-users-spinner" aria-hidden="true" />Загружаем список пользователей…</div>
        : loadError ? <div className="access-users-state">Список временно недоступен. Повторите загрузку.</div>
          : users.length === 0 ? <div className="access-users-empty"><span aria-hidden="true">♙</span><b>Пока нет известных пользователей</b><p>Список появится после первого входа пользователя в CRM.</p></div>
            : <div className="access-users-list">{users.map((user) => {
              const isEditing = editingSub === user.sub;
              const isBusy = busySub === user.sub;
              return <article ref={(element) => { if (element) accessUserCards.current.set(user.sub, element); else accessUserCards.current.delete(user.sub); }} className={`access-user-card${user.enabled ? '' : ' is-disabled'}`} key={user.sub}>
                <div className="access-user-main">
                  <div className="access-user-identity"><UserAvatar name={user.name || ''} className="access-user-avatar" /><div className="access-user-name"><h3>{user.name || 'Без имени'}</h3><code title={user.sub}>{user.sub}</code></div></div>
                  <span className={`access-user-status${user.enabled ? ' enabled' : ' disabled'}`}><i aria-hidden="true" />{user.enabled ? 'Доступ включён' : 'Доступ отключён'}</span>
                </div>

                <div className="access-user-meta">
                  <div className="access-user-roles"><span className="access-user-meta-label">Роли Keycloak</span><div className="access-user-role-list">{user.roles.length ? user.roles.map((role) => <span className="access-user-role" key={role}>{roleLabels[role] ?? role}</span>) : <span className="access-user-no-role">Нет ролей</span>}</div></div>
                  <dl className="access-user-dates"><div><dt>Последнее обращение к CRM</dt><dd>{formatDate(user.lastSeenAt)}</dd></div><div><dt>Доступ изменён</dt><dd>{formatDate(user.updatedAt)}</dd></div></dl>
                </div>
                <div className="access-user-scope"><span className="access-user-meta-label">Доступные процессы</span><b>{user.allowedKinds == null ? 'Все три процесса' : user.allowedKinds.length ? user.allowedKinds.map((kind) => kindLabels[kind]).join(' · ') : 'Нет доступа к процессам'}</b></div>
                <div className="access-user-scope"><span className="access-user-meta-label">Организации</span><b>{user.allowedOrganizationIds == null ? 'Все организации' : user.allowedOrganizationIds.length ? `Выбрано: ${user.allowedOrganizationIds.length}` : 'Нет доступа к связанным организациям'}</b></div>

                {user.reason && <p className="access-user-reason"><b>Причина отключения доступа:</b> {user.reason}</p>}

                <div className="access-user-actions">
                  {!isEditing && scopeSub !== user.sub && organizationSub !== user.sub ? <><button data-access-action="scope" className="secondary" type="button" disabled={busySub !== null || loading} onClick={() => beginScope(user)}>Изменить процессы</button><button data-access-action="organizations" className="secondary" type="button" disabled={busySub !== null || loading} onClick={() => { cancelChange(); setScopeSub(null); setOrganizationSub(user.sub); focusUserEditor(user.sub); }}>Организации</button><button data-access-action="access" className={user.enabled ? 'access-user-disable' : 'access-user-enable'} type="button" disabled={busySub !== null || loading} onClick={() => beginChange(user)}>{user.enabled ? 'Отключить доступ' : 'Включить доступ'}</button></>
                    : scopeSub === user.sub ? <div className="access-user-confirm"><b>Какие процессы доступны пользователю</b><div className="access-scope-options">{allKinds.map((kind) => <label key={kind}><input type="checkbox" checked={scopeKinds.includes(kind)} disabled={isBusy} onChange={(event) => setScopeKinds((current) => event.target.checked ? [...current, kind] : current.filter((item) => item !== kind))} />{kindLabels[kind]}</label>)}</div><p>Сужение области закроет карточки и ранее созданные выгрузки вне разрешённых процессов. Пустой выбор закрывает все бизнес-процессы.</p><label className="access-users-field"><span>Причина изменения <small>обязательно</small></span><textarea value={scopeReason} maxLength={500} rows={2} disabled={isBusy} onChange={(event) => setScopeReason(event.target.value)} /></label><div className="access-user-confirm-actions"><button className="secondary" type="button" disabled={isBusy} onClick={() => { setScopeSub(null); focusUserAction(user.sub, 'scope'); }}>Отмена</button><button className="primary" type="button" disabled={isBusy || !scopeReason.trim()} onClick={() => void saveScope(user)}>{isBusy ? 'Сохраняем…' : 'Сохранить область'}</button></div></div>
                    : organizationSub === user.sub ? <OrganizationScopeEditor api={api} user={user} onSaved={organizationSaved} onCancel={() => { setOrganizationSub(null); focusUserAction(user.sub, 'organizations'); }} />
                    : <div className="access-user-confirm" aria-labelledby={`access-confirm-title-${user.sub}`}>
                      <div className="access-user-confirm-copy"><b id={`access-confirm-title-${user.sub}`}>{user.enabled ? 'Отключить доступ этому пользователю?' : 'Включить доступ этому пользователю?'}</b><p>{user.enabled ? 'CRM сразу отклонит запросы пользователя, включая запросы с действующим сеансом. Назначенные роли и записи сохранятся.' : 'CRM снова примет запросы пользователя с его текущими ролями. Отдельная блокировка в Keycloak при этом не снимается.'} Действие будет записано в журнал с указанной причиной.</p></div>
                      <label className="access-users-field"><span>Причина изменения <small>обязательно</small></span><textarea value={reason} maxLength={500} rows={2} disabled={isBusy} onChange={(event) => setReason(event.target.value)} placeholder={user.enabled ? 'Например: доступ больше не требуется' : 'Например: доступ восстановлен по заявке'} /></label>
                      <label className="access-user-confirm-check"><input type="checkbox" checked={confirmed} disabled={isBusy} onChange={(event) => setConfirmed(event.target.checked)} /><span>Я понимаю последствия изменения доступа.</span></label>
                      <div className="access-user-confirm-actions"><button className="secondary" type="button" disabled={isBusy} onClick={() => cancelChange(user.sub)}>Отмена</button><button className={user.enabled ? 'access-user-disable' : 'access-user-enable'} type="button" disabled={isBusy || !reason.trim() || !confirmed} onClick={() => void saveChange(user)}>{isBusy ? 'Сохраняем…' : user.enabled ? 'Подтвердить отключение' : 'Подтвердить включение'}</button></div>
                    </div>}
                </div>
              </article>;
            })}</div>}
    </section>
  </div>;
}
