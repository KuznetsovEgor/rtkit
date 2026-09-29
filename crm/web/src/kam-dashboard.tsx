import { useEffect, useState } from 'react';
import { KamPipeline } from './KamPipeline';
import './kam-dashboard.css';

type ApiCall = <T,>(path: string, init?: RequestInit) => Promise<T>;
type Totals = { all: number; overdue: number; awaiting_reply: number; no_next_step: number };
type Segment = 'all' | 'university' | 'company' | 'individual';
type Collection = 'all' | 'overdue' | 'awaiting_reply' | 'no_next_step';
type RouteVersion = 'legacy' | 'v2';

export function KamDashboard({ api, onQueue }: { api: ApiCall; onQueue: (segment: Segment, collection: Collection, routeVersion?: RouteVersion) => void }) {
  const [totals, setTotals] = useState<Totals | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setError(''); setTotals(null);
    const count = async (segment: Segment, collection: Collection) => {
      const query = new URLSearchParams({ segment, collection, offset: '0', limit: '1' });
      return (await api<{ total: number }>(`/api/activities?${query}`)).total;
    };
    Promise.all([
      count('all', 'all'), count('all', 'overdue'), count('all', 'awaiting_reply'), count('all', 'no_next_step'),
    ]).then(([all, overdue, awaiting_reply, no_next_step]) => {
      if (live) setTotals({ all, overdue, awaiting_reply, no_next_step });
    }).catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить показатели.'); });
    return () => { live = false; };
  }, [api, revision]);
  const cards: { label: string; key: keyof Totals; collection: Collection; hint: string }[] = [
    { label: 'Мои активности', key: 'all', collection: 'all', hint: 'доступные взаимодействия' },
    { label: 'Просрочено', key: 'overdue', collection: 'overdue', hint: 'активности с просроченным действием' },
    { label: 'Ожидают ответа', key: 'awaiting_reply', collection: 'awaiting_reply', hint: 'последний итог контакта' },
    { label: 'Без следующего шага', key: 'no_next_step', collection: 'no_next_step', hint: 'нет открытой задачи' },
  ];
  return <div className="kam-dashboard">
    <div className="page-heading kam-dashboard-heading"><div><div className="eyebrow">МОЯ РАБОТА · CRM</div><h1>Мои показатели</h1><p>Действия и узкие места в вашей текущей области доступа</p></div><button className="secondary" onClick={() => setRevision((value) => value + 1)}>Обновить</button></div>
    {error && <p role="alert" className="activity-updates-error">{error}</p>}
    {!totals ? <section className="panel"><p className="muted-copy">{error ? 'Показатели временно недоступны.' : 'Загружаем показатели…'}</p></section> : <>
      <section className="kam-dashboard-metrics" aria-label="Состояние моего портфеля">{cards.map((card) => <button key={card.key} className={`kam-dashboard-metric metric-${card.collection}`} onClick={() => onQueue('all', card.collection)}><span className="kam-dashboard-metric-label">{card.label}</span><strong>{totals[card.key]}</strong><span className="kam-dashboard-metric-hint">{card.hint}</span></button>)}</section>
      <KamPipeline api={api} onOpenQueue={(segment, routeVersion) => onQueue(segment, 'all', routeVersion)} />
    </>}
  </div>;
}
