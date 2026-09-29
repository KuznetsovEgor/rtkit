import { useEffect, useMemo, useRef, useState } from 'react';
import './organization-scope.css';

type ApiCall = <T,>(path: string, init?: RequestInit) => Promise<T>;
type Organization = { id: string; name: string; segment: string };
type OrganizationsResponse = { organizations: Organization[] };
export type OrganizationScopeUser = {
  sub: string;
  name: string;
  allowedOrganizationIds: string[] | null;
  scopeRevision: number;
};
type ErrorWithStatus = Error & { status?: number; code?: string };

function messageOf(reason: unknown) {
  return reason instanceof Error ? reason.message : 'Не удалось выполнить действие.';
}

function isRevisionConflict(reason: unknown) {
  const error = reason as ErrorWithStatus;
  return error?.status === 409 || error?.code === 'organization_scope_revision_conflict';
}

export function OrganizationScopeEditor({
  api,
  user,
  onSaved,
  onCancel,
}: {
  api: ApiCall;
  user: OrganizationScopeUser;
  onSaved: (updated: OrganizationScopeUser) => void;
  onCancel: () => void;
}) {
  const [allOrganizations, setAllOrganizations] = useState(user.allowedOrganizationIds === null);
  const [selectedIds, setSelectedIds] = useState<string[]>(() => [...new Set(user.allowedOrganizationIds ?? [])]);
  const [search, setSearch] = useState('');
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [revisionConflict, setRevisionConflict] = useState(false);
  const requestSequence = useRef(0);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setLoadError('');
      const query = search.trim();
      const path = `/api/admin/access/organizations${query ? `?search=${encodeURIComponent(query)}` : ''}`;
      void api<OrganizationsResponse>(path).then((result) => {
        if (sequence === requestSequence.current) setOrganizations(result.organizations.slice(0, 100));
      }).catch((error: unknown) => {
        if (sequence === requestSequence.current) setLoadError(messageOf(error));
      }).finally(() => {
        if (sequence === requestSequence.current) setLoading(false);
      });
    }, search ? 220 : 0);

    return () => window.clearTimeout(timer);
  }, [api, search, loadAttempt]);

  useEffect(() => {
    setAllOrganizations(user.allowedOrganizationIds === null);
    setSelectedIds([...new Set(user.allowedOrganizationIds ?? [])]);
    setReason('');
    setSaveError('');
    setRevisionConflict(false);
  }, [user.sub, user.scopeRevision]);

  const selectedOrganizations = useMemo(() => organizations.filter((organization) => selectedIds.includes(organization.id)), [organizations, selectedIds]);
  const missingSelectedCount = Math.max(0, selectedIds.length - selectedOrganizations.length);

  function toggleOrganization(id: string, checked: boolean) {
    setSelectedIds((current) => checked
      ? current.includes(id) ? current : [...current, id]
      : current.filter((selectedId) => selectedId !== id));
    setSaveError('');
  }

  async function save() {
    const trimmedReason = reason.trim();
    if (!trimmedReason || saving || revisionConflict) return;
    setSaving(true);
    setSaveError('');
    try {
      const updated = await api<OrganizationScopeUser>(`/api/admin/access/users/${encodeURIComponent(user.sub)}/organizations`, {
        method: 'PUT',
        body: JSON.stringify({
          allowedOrganizationIds: allOrganizations ? null : [...new Set(selectedIds)],
          expectedRevision: user.scopeRevision,
          reason: trimmedReason,
        }),
      });
      onSaved(updated);
    } catch (error) {
      setSaveError(isRevisionConflict(error)
        ? 'Данные доступа изменились после открытия редактора. Закройте его и откройте снова, чтобы загрузить актуальные настройки.'
        : messageOf(error));
      if (isRevisionConflict(error)) setRevisionConflict(true);
    } finally {
      setSaving(false);
    }
  }

  return <section className="organization-scope-editor" aria-labelledby="organization-scope-title" aria-busy={saving}>
    <header className="organization-scope-heading">
      <div>
        <div className="organization-scope-eyebrow">ОГРАНИЧЕНИЕ ДОСТУПА</div>
        <h2 id="organization-scope-title">Организации для {user.name || user.sub}</h2>
        <p>Выберите, с какими организациями пользователь может работать.</p>
      </div>
    </header>

    <fieldset className="organization-scope-mode" disabled={saving}>
      <legend>Область организаций</legend>
      <label className={allOrganizations ? 'is-selected' : ''}>
        <input type="radio" name={`organization-scope-${user.sub}`} checked={allOrganizations} onChange={() => { setAllOrganizations(true); setSaveError(''); }} />
        <span><b>Все организации</b><small>Доступ не ограничен списком организаций</small></span>
      </label>
      <label className={!allOrganizations ? 'is-selected' : ''}>
        <input type="radio" name={`organization-scope-${user.sub}`} checked={!allOrganizations} onChange={() => { setAllOrganizations(false); setSaveError(''); }} />
        <span><b>Только выбранные</b><small>{selectedIds.length ? `Выбрано: ${selectedIds.length}` : 'Пока ничего не выбрано'}</small></span>
      </label>
    </fieldset>

    <div className={`organization-scope-picker${allOrganizations ? ' is-disabled' : ''}`}>
      <label className="organization-scope-search">
        <span>Найти организацию</span>
        <input type="search" value={search} disabled={allOrganizations || saving} onChange={(event) => { setLoading(true); setSearch(event.target.value); }} placeholder="Название или часть названия" />
      </label>
      {!allOrganizations && <div className="organization-scope-selection" aria-live="polite">
        <b>Выбрано организаций: {selectedIds.length}</b>
        {missingSelectedCount > 0 && <span>{missingSelectedCount} выбранных организаций не показаны в текущем поиске</span>}
      </div>}
      {!allOrganizations && loadError && <div className="organization-scope-error" role="alert">
        <span>Не удалось загрузить организации. {loadError}</span>
        <button className="secondary" type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Повторить</button>
      </div>}
      {!allOrganizations && loading && <div className="organization-scope-state" role="status"><i aria-hidden="true" />Загружаем организации…</div>}
      {!allOrganizations && !loading && !loadError && organizations.length === 0 && <div className="organization-scope-state">Организации не найдены. Попробуйте изменить запрос.</div>}
      {!allOrganizations && !loading && !loadError && organizations.length > 0 && <div className="organization-scope-results" role="group" aria-label="Результаты поиска организаций">
        {organizations.map((organization) => <label className="organization-scope-option" key={organization.id}>
          <input type="checkbox" checked={selectedIds.includes(organization.id)} disabled={saving} onChange={(event) => toggleOrganization(organization.id, event.target.checked)} />
          <span className="organization-scope-option-copy"><b>{organization.name}</b><small>{organization.segment}</small></span>
        </label>)}
      </div>}
      {!allOrganizations && !loadError && <p className="organization-scope-limit">Поиск показывает до 100 организаций. Уточните запрос, если нужной организации нет в списке.</p>}
    </div>

    <aside className="organization-scope-note">
      <span aria-hidden="true">i</span>
      <p>Это ограничение дополняет доступ к процессам. Физлицо, не связанное с организацией, по-прежнему доступно в рамках разрешённых процессов.</p>
    </aside>

    {saveError && <div className="organization-scope-error organization-scope-save-error" role="alert">{saveError}</div>}

    <label className="organization-scope-reason">
      <span>Причина изменения <small>обязательно</small></span>
      <textarea value={reason} maxLength={500} rows={2} disabled={saving} onChange={(event) => setReason(event.target.value)} placeholder="Например: доступ ограничен по заявке руководителя" />
    </label>

    <footer className="organization-scope-actions">
      <button className="secondary" type="button" disabled={saving} onClick={onCancel}>{revisionConflict ? 'Закрыть редактор' : 'Отмена'}</button>
      {!revisionConflict && <button className="primary" type="button" disabled={saving || !reason.trim()} onClick={() => void save()}>{saving ? 'Сохраняем…' : 'Сохранить доступ'}</button>}
    </footer>
  </section>;
}
