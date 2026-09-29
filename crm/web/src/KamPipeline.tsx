import { useEffect, useState } from 'react';
import './KamPipeline.css';

type ApiCall = <T,>(path: string, init?: RequestInit) => Promise<T>;
type Segment = 'university' | 'company' | 'individual';
type RouteVersion = 'legacy' | 'v2';
type PipelineActivity = {
  id: string;
  kind: 'university' | 'corporate' | 'individual';
  title: string;
  stageKey: string;
  stageLabel: string;
  routeVersion?: RouteVersion;
  allowedNextLabels?: string[];
  organizationName?: string;
  personName?: string;
  awaitingReply?: boolean;
  nextTaskTitle?: string;
  nextTaskDueAt?: string;
};
type ActivityPage = { items: PipelineActivity[]; total: number };
type LaneDefinition = {
  id: string;
  segment: Segment;
  routeVersion?: RouteVersion;
  label: string;
  context: string;
};
type LaneData = LaneDefinition & ActivityPage;

const LANES: LaneDefinition[] = [
  { id: 'university', segment: 'university', label: 'Партнёрства с вузами и школами', context: 'Общий маршрут' },
  { id: 'corporate', segment: 'company', label: 'Корпоративное обучение', context: 'Маршрут компании' },
  { id: 'individual-legacy', segment: 'individual', routeVersion: 'legacy', label: 'Индивидуальное обучение', context: 'Заявки до обновления маршрута' },
  { id: 'individual-v2', segment: 'individual', routeVersion: 'v2', label: 'Индивидуальное обучение', context: 'Заявки по новой схеме' },
];

function requestPath(lane: LaneDefinition) {
  const query = new URLSearchParams({ segment: lane.segment, collection: 'all', offset: '0', limit: '4' });
  if (lane.routeVersion) query.set('routeVersion', lane.routeVersion);
  return `/api/activities?${query}`;
}

function formatDue(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const dateLabel = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'Europe/Moscow' }).format(date);
  const timeLabel = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(date);
  return `${dateLabel} · ${timeLabel}`;
}

function dueTone(value?: string) {
  if (!value) return '';
  const dueAt = new Date(value).getTime();
  if (Number.isNaN(dueAt)) return '';
  return dueAt < Date.now() ? ' is-overdue' : '';
}

function ActivityCard({ item }: { item: PipelineActivity }) {
  const next = item.allowedNextLabels ?? [];
  const nextLabel = next.length > 1 ? `Доступные переходы: ${next.join(' / ')}` : next[0] ?? 'Нет следующего перехода в схеме';
  const dueLabel = formatDue(item.nextTaskDueAt);
  const identity = item.organizationName ?? item.personName;
  return <article className="kam-pipeline-activity">
    <span className="kam-pipeline-activity-title">{item.title}</span>
    {identity && <span className="kam-pipeline-identity">{identity}</span>}
    <span className="kam-pipeline-route" aria-label="Текущая стадия и следующий рубеж">
      <span className="kam-pipeline-route-point"><small>СЕЙЧАС</small><b>{item.stageLabel}</b></span>
      <span className="kam-pipeline-arrow" aria-hidden="true">→</span>
      <span className="kam-pipeline-route-point kam-pipeline-next"><small>ДАЛЕЕ</small><b>{nextLabel}</b></span>
    </span>
    {(item.nextTaskTitle || item.awaitingReply) && <span className="kam-pipeline-action">
      {item.awaitingReply && <span className="kam-pipeline-awaiting">Ожидается ответ</span>}
      {item.nextTaskTitle && <span className={`kam-pipeline-task${dueTone(item.nextTaskDueAt)}`}>
        <span>{item.nextTaskTitle}</span>{dueLabel && <time dateTime={item.nextTaskDueAt}>{dueLabel}</time>}
      </span>}
    </span>}
  </article>;
}

/**
 * Compact KAM portfolio view: each item shows its persisted stage and server-provided
 * allowed next milestone. It intentionally does not infer percentage completion.
 */
export function KamPipeline({ api, onOpenQueue }: {
  api: ApiCall;
  onOpenQueue: (segment: Segment, routeVersion?: RouteVersion) => void;
}) {
  const [lanes, setLanes] = useState<LaneData[] | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let live = true;
    setLanes(null);
    setError('');
    Promise.all(LANES.map(async (lane): Promise<LaneData> => {
      const page = await api<ActivityPage>(requestPath(lane));
      return { ...lane, ...page };
    })).then((result) => { if (live) setLanes(result); })
      .catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить портфель.'); });
    return () => { live = false; };
  }, [api, revision]);

  return <section className="kam-pipeline panel" aria-labelledby="kam-pipeline-title">
    <div className="kam-pipeline-heading">
      <div><div className="eyebrow">МОЙ КЛИЕНТСКИЙ ПОРТФЕЛЬ</div><h2 id="kam-pipeline-title">Положение и следующий рубеж</h2>
        <p>Показываем текущую стадию и разрешённый следующий переход для открытых активностей.</p>
      </div>
      <button className="secondary" type="button" onClick={() => setRevision((value) => value + 1)}>Обновить</button>
    </div>
    {error && <p className="kam-pipeline-error" role="alert">{error}</p>}
    {!lanes ? <p className="kam-pipeline-empty">{error ? 'Данные временно недоступны.' : 'Загружаем активный портфель…'}</p> : <div className="kam-pipeline-lanes">
      {lanes.map((lane) => <section className="kam-pipeline-lane" key={lane.id} aria-label={`${lane.label}, ${lane.context}`}>
        <header className="kam-pipeline-lane-heading">
          <div><h3>{lane.label}</h3><span>{lane.context}</span></div>
          <strong>{lane.total}</strong>
        </header>
        {lane.items.length ? <div className="kam-pipeline-activities">
          {lane.items.map((item) => <ActivityCard key={item.id} item={item} />)}
        </div> : <p className="kam-pipeline-empty-lane">Активных обращений нет.</p>}
        {lane.total > lane.items.length && <p className="kam-pipeline-more">Показаны приоритетные записи: {lane.items.length} из {lane.total}.</p>}
        <button className="kam-pipeline-queue" type="button" onClick={() => onOpenQueue(lane.segment, lane.routeVersion)}>
          {lane.routeVersion ? 'Открыть заявки этого маршрута' : 'Открыть очередь'} <span aria-hidden="true">→</span>
        </button>
      </section>)}
    </div>}
    <p className="kam-pipeline-footnote">Версия маршрута зависит от времени заявки, а не от того, обращается ли клиент повторно.</p>
  </section>;
}
