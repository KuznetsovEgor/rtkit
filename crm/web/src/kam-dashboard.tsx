import { useEffect, useState } from 'react';
import { KamPipeline } from './KamPipeline';
import { formatRussianCount } from './russian-count';
import './kam-dashboard.css';

type ApiCall = <T,>(path: string, init?: RequestInit) => Promise<T>;
type Totals = { all: number; overdue: number; awaiting_reply: number; no_next_step: number };
type Segment = 'all' | 'university' | 'company' | 'individual';
type Collection = 'all' | 'overdue' | 'awaiting_reply' | 'no_next_step';
type RouteVersion = 'legacy' | 'v2';

const signals = [
  { key: 'overdue', label: 'Просрочено', hint: 'Вернитесь к действиям, срок которых уже прошёл', icon: '!' },
  { key: 'awaiting_reply', label: 'Ожидают ответа', hint: 'Проверьте договорённости после последнего контакта', icon: '↗' },
  { key: 'no_next_step', label: 'Без следующего шага', hint: 'Назначьте ближайшее действие со сроком', icon: '+' },
] as const;

const focusContent = {
  overdue: { label: 'просрочено', title: 'Вернитесь к ближайшим действиям', hint: 'Откройте подборку и уточните следующий шаг по каждой активности.', action: 'Разобрать просроченные' },
  no_next_step: { label: 'без следующего шага', title: 'Назначьте ближайшие действия', hint: 'Добавьте задачу со сроком, чтобы каждая активность оставалась в работе.', action: 'Открыть активности без шага' },
  awaiting_reply: { label: 'ожидают ответа', title: 'Продолжите диалог', hint: 'Проверьте договорённости и напомните о следующем шаге.', action: 'Открыть ожидаемые ответы' },
};

export function KamDashboard({ api, onQueue }: { api: ApiCall; onQueue: (segment: Segment, collection: Collection, routeVersion?: RouteVersion) => void }) {
  const [totals, setTotals] = useState<Totals | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setError(''); setTotals(null);
    const count = async (collection: Collection) => {
      const query = new URLSearchParams({ segment: 'all', collection, offset: '0', limit: '1' });
      return (await api<{ total: number }>(`/api/activities?${query}`)).total;
    };
    Promise.all([count('all'), count('overdue'), count('awaiting_reply'), count('no_next_step')])
      .then(([all, overdue, awaiting_reply, no_next_step]) => {
        if (live) setTotals({ all, overdue, awaiting_reply, no_next_step });
      }).catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить показатели.'); });
    return () => { live = false; };
  }, [api, revision]);
  const focus = totals?.overdue ? 'overdue' : totals?.no_next_step ? 'no_next_step' : totals?.awaiting_reply ? 'awaiting_reply' : null;
  const focusCopy = focus ? focusContent[focus] : null;

  return <div className="kam-dashboard">
    <div className="page-heading kam-dashboard-heading"><div><div className="eyebrow">МОЯ РАБОТА · CRM</div><h1>Мои показатели</h1><p>Сначала — действия, которым нужно ваше внимание.</p></div><button className="secondary" onClick={() => setRevision((value) => value + 1)}>Обновить</button></div>
    {error && <p role="alert" className="activity-updates-error">{error}</p>}
    {!totals ? <section className="panel" aria-busy={!error}><p className="muted-copy">{error ? 'Показатели временно недоступны.' : 'Загружаем показатели…'}</p></section> : <>
      <section className="kam-focus" aria-label="Состояние моего портфеля">
        <div className={`kam-focus-primary${!focus ? ' is-clear' : ''}`}>
          <span className="kam-focus-kicker"><i aria-hidden="true" />{focus ? 'В ПЕРВУЮ ОЧЕРЕДЬ' : 'ВСЁ ПОД КОНТРОЛЕМ'}</span>
          <div className="kam-focus-number">{focus ? totals[focus] : 0}<span>{focusCopy?.label ?? 'сигналов внимания'}</span></div>
          <h2>{focusCopy?.title ?? 'Срочных сигналов нет'}</h2>
          <p>{focusCopy?.hint ?? 'Нет просрочек, ожидаемых ответов и открытых активностей без следующего шага.'}</p>
          <button className="kam-focus-cta" onClick={() => onQueue('all', focus ?? 'all')}>{focusCopy?.action ?? 'Открыть рабочую очередь'}<span aria-hidden="true">→</span></button>
        </div>
        <div className="kam-focus-signals">
          <div className="kam-focus-signals-heading"><div className="eyebrow">ОСТАЛЬНЫЕ СИГНАЛЫ</div><h2>Что ещё требует внимания?</h2><p>Сколько открытых активностей в каждой подборке</p></div>
          <div className="kam-signal-list">{signals.filter((signal) => signal.key !== (focus ?? 'overdue')).map((signal) => {
            const count = totals[signal.key];
            const share = totals.all > 0 ? Math.min(100, count / totals.all * 100) : 0;
            return <button className={`kam-signal signal-${signal.key}`} key={signal.key} onClick={() => onQueue('all', signal.key)} aria-label={`${signal.label}: ${count} из ${totals.all}. Открыть подборку.`}>
              <span className="kam-signal-icon" aria-hidden="true">{signal.icon}</span>
              <span className="kam-signal-copy"><span className="kam-signal-title">{signal.label}<strong>{count}<small> / {totals.all}</small></strong></span><span className="kam-signal-track" aria-hidden="true"><span style={{ width: `${share}%` }} /></span><span className="kam-signal-hint">{signal.hint}</span></span>
              <span className="kam-signal-arrow" aria-hidden="true">→</span>
            </button>;
          })}</div>
          <p className="kam-focus-note">Длина полосы — доля от всех открытых активностей. Подборки могут пересекаться.</p>
        </div>
        <button className="kam-focus-portfolio" onClick={() => onQueue('all', 'all')}><span>В вашей области доступа <strong>{formatRussianCount(totals.all, 'открытая активность', 'открытые активности', 'открытых активностей')}</strong></span><span>Вся очередь <b aria-hidden="true">→</b></span></button>
      </section>
      <KamPipeline key={revision} api={api} onOpenQueue={(segment, routeVersion) => onQueue(segment, 'all', routeVersion)} />
    </>}
  </div>;
}
