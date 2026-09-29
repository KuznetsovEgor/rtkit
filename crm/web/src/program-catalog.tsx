import { useEffect, useState, type FormEvent } from 'react';

export type LearningProgram = { id: string; name: string; priority: number; revision: number; demandCount: number };
type Api = <T,>(path: string, init?: RequestInit) => Promise<T>;

export function ProgramCatalog({ api, showDemand }: { api: Api; showDemand: boolean }) {
  const [items, setItems] = useState<LearningProgram[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      const result = await api<{ items: LearningProgram[] }>('/api/programs');
      setItems(result.items);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось загрузить программы.');
    } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, [api]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || busyId) return;
    setBusyId('new'); setError(''); setNotice('');
    try {
      await api('/api/programs', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      setName('');
      await refresh();
      setNotice('Программа добавлена в каталог. Свяжите её с активностью в карточке.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось добавить программу.'); }
    finally { setBusyId(''); }
  }

  async function setPriority(item: LearningProgram, priority: number) {
    if (busyId || priority === item.priority) return;
    setBusyId(item.id); setError(''); setNotice('');
    try {
      await api(`/api/programs/${item.id}/priority`, {
        method: 'PUT', body: JSON.stringify({ priority, expectedRevision: item.revision }),
      });
      await refresh();
      setNotice(`Порядок программы «${item.name}» в каталоге изменён.`);
    } catch (reason) {
      setError(reason instanceof Error ? `${reason.message} Обновите список и повторите действие.` : 'Не удалось изменить приоритет.');
      await refresh();
    } finally { setBusyId(''); }
  }

  return <details className="panel program-catalog">
    <summary>Каталог учебных программ</summary>
    <div className="program-catalog-body">
      <p className="muted-copy">Руководитель или администратор задаёт порядок показа программ в каталоге: 1 — выше, 5 — ниже. Это не план продаж и не оценка спроса.{showDemand ? ' Число активностей отражает только доступные вам записи.' : ''}</p>
      <form className="program-catalog-create" onSubmit={(event) => void create(event)}>
        <label className="field"><span>Новая программа</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={180} placeholder="Название программы" disabled={Boolean(busyId)} required /></label>
        <button className="secondary" disabled={Boolean(busyId) || !name.trim()}>{busyId === 'new' ? 'Добавляем…' : 'Добавить'}</button>
      </form>
      {error && <p role="alert" className="handbook-action-error">{error}</p>}
      {notice && <p role="status" className="muted-copy">{notice}</p>}
      {loading ? <p className="muted-copy">Загружаем программы…</p> : items.length ? <div className="program-catalog-list">{items.map((item) => <div className="program-catalog-row" key={item.id}>
        <div><strong>{item.name}</strong>{showDemand && <small>Доступных активностей: {item.demandCount.toLocaleString('ru-RU')}</small>}</div>
        <label className="field"><span>Порядок в каталоге</span><select value={item.priority} disabled={Boolean(busyId)} onChange={(event) => void setPriority(item, Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} — {['выше всех', 'выше среднего', 'середина', 'ниже среднего', 'ниже всех'][value - 1]}</option>)}</select></label>
      </div>)}</div> : <p className="muted-copy">Программ пока нет. Добавьте первую и выберите её в карточке активности.</p>}
    </div>
  </details>;
}
