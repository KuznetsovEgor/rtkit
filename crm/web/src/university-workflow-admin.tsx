import { useEffect, useMemo, useRef, useState } from 'react';
import { addWorkflowTransition, insertWorkflowStageOnTransition, moveWorkflowStage, removeWorkflowTransition } from './university-workflow-graph';

type Stage = { key: string; label: string; ordinal: number; terminal: boolean };
type Transition = { from: string; to: string };
type WorkflowScheme = { kind: 'university'; revision: number; stages: Stage[]; transitions: Transition[] };
type ImpactedActivity = {
  id: string; title?: string | null; ownerName?: string | null; stageKey: string; stageLabel: string;
  targetStageKey: string | null; targetStageLabel: string | null; closed: boolean; changeRequired: boolean;
};
type WorkflowPreview = {
  kind: 'university'; revision: number; previewToken: string; canApply: boolean; stages: Stage[]; transitions: Transition[];
  mappings: Record<string, string>;
  impactedActivities: ImpactedActivity[];
  counts: { total: number; open: number; closed: number; changedOpen: number; changedClosed: number };
  blockers: { code: string; message: string; activityId?: string; stageKey?: string }[];
};
type ApplyResult = { kind: 'university'; revision: number; migratedCount: number; preservedClosedCount: number; changedActivities: { id: string; title?: string | null; stageKey: string; stageLabel: string; closed: boolean }[] };
type PreviewInput = { expectedRevision: number; stages: Stage[]; transitions: Transition[]; mappings: Record<string, string> };
type WorkflowOperation = 'rename' | 'delete' | 'addStage' | 'reorder' | 'addTransition' | 'removeTransition';
type HandbookItem = { kind: string; stageKey: string; current: boolean; article: unknown | null };
type ApiCall = <T,>(path: string, init?: RequestInit) => Promise<T>;
type ErrorWithStatus = Error & { status?: number; code?: string };

function messageOf(reason: unknown) {
  return reason instanceof Error ? reason.message : 'Не удалось выполнить действие.';
}

function visibleWorkflowLabel(value?: string | null) {
  const label = value?.trim();
  if (!label || /^(?:—|-|n\/a|\*+|\[redacted\]|redacted\b|hidden\b|null\b|undefined\b|скрыт\w*\b|данные скрыты\b|не раскрыт\w*\b|недоступн\w*\b|нет доступа\b)$/i.test(label)) return null;
  return label;
}

function isRevisionConflict(reason: unknown) {
  const error = reason as ErrorWithStatus;
  return error?.status === 409 || error?.code === 'workflow_revision_conflict' || error?.code === 'workflow_preview_stale';
}

function stageLabel(scheme: WorkflowScheme, key: string) {
  return scheme.stages.find((stage) => stage.key === key)?.label ?? key;
}

function orderScheme(stages: Stage[]) {
  return [...stages].sort((a, b) => a.ordinal - b.ordinal);
}

function edgeKey(from: string, to: string) {
  return `${from}:${to}`;
}

export function UniversityWorkflowAdmin({ api, onApplied }: { api: ApiCall; onApplied?: () => void }) {
  const [scheme, setScheme] = useState<WorkflowScheme | null>(null);
  const [handbookItems, setHandbookItems] = useState<HandbookItem[]>([]);
  const [handbookError, setHandbookError] = useState('');
  const [handbookChecked, setHandbookChecked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [stageKey, setStageKey] = useState('');
  const [operation, setOperation] = useState<WorkflowOperation>('rename');
  const [newLabel, setNewLabel] = useState('');
  const [replacementKey, setReplacementKey] = useState('');
  const [newStageKey, setNewStageKey] = useState('');
  const [splitTransitionKey, setSplitTransitionKey] = useState('');
  const [targetOrdinal, setTargetOrdinal] = useState('');
  const [transitionFrom, setTransitionFrom] = useState('');
  const [transitionTo, setTransitionTo] = useState('');
  const [transitionKey, setTransitionKey] = useState('');
  const [extraTransitions, setExtraTransitions] = useState<string[]>([]);
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  const [previewInput, setPreviewInput] = useState<PreviewInput | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [conflict, setConflict] = useState('');
  const [notice, setNotice] = useState('');
  const previewRequestSequence = useRef(0);
  const editHeadingRef = useRef<HTMLHeadingElement>(null);

  async function refreshScheme() {
    setLoading(true);
    setLoadError('');
    try {
      const current = await api<WorkflowScheme>('/api/admin/workflow/university');
      setScheme(current);
      setStageKey((previous) => current.stages.some((stage) => stage.key === previous && !stage.terminal) ? previous : orderScheme(current.stages).find((stage) => !stage.terminal)?.key ?? '');
    } catch (reason) {
      setLoadError(messageOf(reason));
    } finally {
      setLoading(false);
    }
  }

  async function refreshHandbook() {
    setHandbookError('');
    setHandbookChecked(false);
    try {
      const result = await api<{ items: HandbookItem[] }>('/api/admin/guidance/handbook');
      setHandbookItems(result.items);
    } catch (reason) {
      setHandbookError(messageOf(reason));
    } finally {
      setHandbookChecked(true);
    }
  }

  useEffect(() => { void refreshScheme(); void refreshHandbook(); }, [api]);

  const selectedStage = scheme?.stages.find((stage) => stage.key === stageKey) ?? null;
  const editableStages = useMemo(() => orderScheme(scheme?.stages ?? []).filter((stage) => !stage.terminal), [scheme]);
  const stageInstruction = (key: string) => {
    if (handbookError) return { label: 'Не удалось проверить инструкцию', state: 'unknown' };
    if (!handbookChecked) return { label: 'Проверяем привязку инструкции', state: 'unknown' };
    const item = handbookItems.find((entry) => entry.kind === 'university' && entry.stageKey === key && entry.current);
    return item?.article
      ? { label: 'Инструкция привязана', state: 'bound' }
      : { label: 'Инструкция не привязана', state: 'missing' };
  };
  const adjacentStages = useMemo(() => {
    if (!scheme || !stageKey) return [];
    const keys = new Set(scheme.transitions.flatMap((transition) => {
      if (transition.from === stageKey) return [transition.to];
      if (transition.to === stageKey) return [transition.from];
      return [];
    }));
    return orderScheme(scheme.stages.filter((stage) => stage.key !== stageKey && keys.has(stage.key)));
  }, [scheme, stageKey]);
  const routeRepairOptions = useMemo(() => {
    if (!scheme || !stageKey) return [];
    const incoming = scheme.transitions.filter((transition) => transition.to === stageKey);
    const outgoing = scheme.transitions.filter((transition) => transition.from === stageKey);
    const existing = new Set(scheme.transitions.map((transition) => `${transition.from}\u0000${transition.to}`));
    return incoming.flatMap((from) => outgoing
      .filter((to) => from.from !== to.to && !existing.has(`${from.from}\u0000${to.to}`))
      .map((to) => ({ from: from.from, to: to.to, key: `${from.from}\u0000${to.to}` })));
  }, [scheme, stageKey]);
  const transitionsForSelection = useMemo(() => {
    if (!scheme) return [];
    return [...scheme.transitions].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  }, [scheme]);
  const addTransitionTargets = useMemo(() => {
    if (!scheme || !transitionFrom) return [];
    const existing = new Set(scheme.transitions.map((edge) => edgeKey(edge.from, edge.to)));
    return orderScheme(scheme.stages).filter((stage) => stage.key !== transitionFrom && !existing.has(edgeKey(transitionFrom, stage.key)));
  }, [scheme, transitionFrom]);

  function resetPreview() {
    previewRequestSequence.current += 1;
    setPreview(null);
    setPreviewInput(null);
    setConfirmed(false);
    setPreviewBusy(false);
    setConflict('');
    setActionError('');
  }

  function buildPreviewInput(): PreviewInput | null {
    if (!scheme) return null;
    if (operation === 'rename') {
      if (!selectedStage || selectedStage.terminal) return null;
      const label = newLabel.trim();
      if (!label || label === selectedStage.label) return null;
      return {
        expectedRevision: scheme.revision,
        stages: scheme.stages.map((stage) => stage.key === selectedStage.key ? { ...stage, label } : stage),
        transitions: scheme.transitions,
        mappings: {},
      };
    }
    if (operation === 'delete') {
      if (!selectedStage || selectedStage.terminal || !replacementKey) return null;
      const kept = scheme.transitions.filter((transition) => transition.from !== selectedStage.key && transition.to !== selectedStage.key);
      const selectedEdges = routeRepairOptions.filter((edge) => extraTransitions.includes(edge.key)).map(({ from, to }) => ({ from, to }));
      const stages = orderScheme(scheme.stages.filter((stage) => stage.key !== selectedStage.key))
        .map((stage, index) => ({ ...stage, ordinal: index + 1 }));
      return { expectedRevision: scheme.revision, stages, transitions: [...kept, ...selectedEdges], mappings: { [selectedStage.key]: replacementKey } };
    }
    if (operation === 'addStage') {
      const key = newStageKey.trim();
      const label = newLabel.trim();
      const split = transitionsForSelection.find((edge) => edgeKey(edge.from, edge.to) === splitTransitionKey);
      if (!key || !label || !split) return null;
      const graph = insertWorkflowStageOnTransition(scheme.stages, scheme.transitions, { key, label, ordinal: 1, terminal: false }, split);
      return { expectedRevision: scheme.revision, ...graph, mappings: {} };
    }
    if (operation === 'reorder') {
      if (!selectedStage || selectedStage.terminal || !targetOrdinal) return null;
      return { expectedRevision: scheme.revision, stages: moveWorkflowStage(scheme.stages, selectedStage.key, Number(targetOrdinal)), transitions: scheme.transitions, mappings: {} };
    }
    if (operation === 'addTransition') {
      if (!transitionFrom || !transitionTo) return null;
      return { expectedRevision: scheme.revision, stages: scheme.stages, transitions: addWorkflowTransition(scheme.transitions, { from: transitionFrom, to: transitionTo }), mappings: {} };
    }
    const edge = transitionsForSelection.find((item) => edgeKey(item.from, item.to) === transitionKey);
    if (!edge) return null;
    return { expectedRevision: scheme.revision, stages: scheme.stages, transitions: removeWorkflowTransition(scheme.transitions, edge), mappings: {} };
  }

  async function requestPreview() {
    const input = buildPreviewInput();
    if (!input) return;
    const requestId = ++previewRequestSequence.current;
    setPreviewBusy(true);
    setConflict('');
    setNotice('');
    setLoadError('');
    setActionError('');
    setPreview(null);
    setPreviewInput(null);
    setConfirmed(false);
    try {
      const result = await api<WorkflowPreview>('/api/admin/workflow/university/preview', { method: 'POST', body: JSON.stringify(input) });
      if (requestId !== previewRequestSequence.current) return;
      setPreview(result);
      setPreviewInput(input);
    } catch (reason) {
      if (requestId !== previewRequestSequence.current) return;
      if (isRevisionConflict(reason)) {
        setConflict('Схема или данные активностей изменились после последней загрузки. Текущая версия обновлена; проверьте правку и постройте предпросмотр заново.');
        setExtraTransitions([]);
        await refreshScheme();
        await refreshHandbook();
      } else setActionError(messageOf(reason));
    } finally {
      if (requestId === previewRequestSequence.current) setPreviewBusy(false);
    }
  }

  async function applyPreview() {
    if (!preview || !previewInput || !preview.canApply || !confirmed || !scheme) return;
    setApplyBusy(true);
    setConflict('');
    setLoadError('');
    setActionError('');
    try {
      const result = await api<ApplyResult>('/api/admin/workflow/university/apply', {
        method: 'POST', body: JSON.stringify({ ...previewInput, previewToken: preview.previewToken }),
      });
      setNotice(`Схема обновлена до ревизии ${result.revision}. Перенесено активностей: ${result.migratedCount}; закрытых записей сохранено: ${result.preservedClosedCount}.`);
      resetPreview();
      setOperation('rename');
      setNewLabel('');
      setNewStageKey('');
      setSplitTransitionKey('');
      setReplacementKey('');
      setTargetOrdinal('');
      setTransitionFrom('');
      setTransitionTo('');
      setTransitionKey('');
      onApplied?.();
      await refreshScheme();
      await refreshHandbook();
    } catch (reason) {
      if (isRevisionConflict(reason)) {
        resetPreview();
        setConflict('Изменения схемы или активностей успели сохраниться параллельно. Ничего не перезаписано. Обновлена текущая схема; постройте новый предпросмотр.');
        setExtraTransitions([]);
        await refreshScheme();
        await refreshHandbook();
      } else setActionError(messageOf(reason));
    } finally {
      setApplyBusy(false);
    }
  }

  const canPreview = Boolean(scheme && (operation === 'rename'
    ? selectedStage && !selectedStage.terminal && newLabel.trim() && newLabel.trim() !== selectedStage.label
    : operation === 'delete'
      ? selectedStage && !selectedStage.terminal && replacementKey && adjacentStages.some((stage) => stage.key === replacementKey)
      : operation === 'addStage'
        ? scheme.stages.length < 40 && /^[a-z][a-z0-9_]{0,79}$/.test(newStageKey.trim()) && !scheme.stages.some((stage) => stage.key === newStageKey.trim()) && Boolean(newLabel.trim()) && newLabel.trim().length <= 120 && transitionsForSelection.some((edge) => edgeKey(edge.from, edge.to) === splitTransitionKey)
        : operation === 'reorder'
          ? selectedStage && !selectedStage.terminal && targetOrdinal && Number(targetOrdinal) !== selectedStage.ordinal
          : operation === 'addTransition'
            ? transitionFrom && transitionTo && transitionFrom !== transitionTo && addTransitionTargets.some((stage) => stage.key === transitionTo) && scheme.transitions.length < 160
            : transitionsForSelection.some((edge) => edgeKey(edge.from, edge.to) === transitionKey)));
  const editorLocked = loading || previewBusy || applyBusy;
  const operationLabels: Record<WorkflowOperation, string> = {
    rename: 'Переименовать стадию', delete: 'Удалить стадию', addStage: 'Добавить стадию', reorder: 'Изменить порядок', addTransition: 'Добавить переход', removeTransition: 'Удалить переход',
  };

  return <div className="university-workflow-page">
    <div className="page-heading workflow-admin-heading">
      <div><div className="eyebrow">АДМИНИСТРИРОВАНИЕ · ВУЗЫ</div><h1>Схема партнёрства</h1><p>Единый маршрут для всех вузов. Изменения затрагивают активности вузов по всей команде.</p></div>
      <button className="secondary workflow-refresh" type="button" disabled={loading || previewBusy || applyBusy} onClick={() => { resetPreview(); void refreshScheme(); void refreshHandbook(); }}>↻ <span>Обновить схему</span></button>
    </div>

    {notice && <div className="workflow-notice" role="status"><span>✓</span>{notice}</div>}
    {conflict && <div className="workflow-conflict" role="alert"><b>Схема обновилась</b><span>{conflict}</span></div>}
    {loadError && <div className="workflow-error" role="alert"><b>Не удалось загрузить схему</b><span>{loadError}</span><button className="secondary" type="button" onClick={() => void refreshScheme()}>Повторить</button></div>}
    {actionError && <div className="workflow-error" role="alert"><b>Не удалось продолжить изменение</b><span>{actionError}</span></div>}

    <section className="panel workflow-scheme-panel">
      <div className="section-top"><div><div className="eyebrow">ТЕКУЩАЯ ГЛОБАЛЬНАЯ СХЕМА</div><h2>Маршрут вузовского партнёрства</h2></div>{scheme && <span className="workflow-revision">Ревизия {scheme.revision}</span>}</div>
      {loading ? <p className="muted-copy">Загружаем общую схему…</p> : scheme && <>
        <p className="workflow-scope-note">Изменение стадии здесь применяется ко всем вузовским активностям. Активности компаний и физлиц остаются в своих схемах.</p>
        <p className="workflow-handbook-gap">Статус инструкции сверяется с общим справочником. Руководитель готовит черновик, администратор публикует его для текущего ключа стадии в справочнике этапов.</p>
        <div className="workflow-stage-list" aria-label="Текущие стадии">
          {orderScheme(scheme.stages).map((stage) => {
            const next = scheme.transitions.filter((transition) => transition.from === stage.key).map((transition) => stageLabel(scheme, transition.to));
            const previous = scheme.transitions.filter((transition) => transition.to === stage.key).map((transition) => stageLabel(scheme, transition.from));
            const instruction = stageInstruction(stage.key);
            return <article className="workflow-stage-card" key={stage.key}>
              <span className="workflow-stage-order">{stage.ordinal}</span>
              <div className="workflow-stage-copy"><b>{stage.label} {stage.terminal && <span className="workflow-terminal-lock" title="Завершающая стадия защищена">🔒</span>}</b><code>{stage.key}</code><small>{stage.terminal ? 'Завершающая стадия · порядок и переходы защищены' : `Далее: ${next.length ? next.join(' · ') : 'переходов нет'}`}</small>
                {!!previous.length && <small>Перед ней: {previous.join(' · ')}</small>}
                <span className={`workflow-instruction-status ${instruction.state}`}>{instruction.label}</span>
              </div>
            </article>;
          })}
        </div>
        {!scheme.stages.length && <p className="muted-copy">В схеме пока нет стадий.</p>}
      </>}
    </section>

    <section className="panel workflow-edit-panel">
      <div className="section-top"><div><div className="eyebrow">ИЗМЕНЕНИЕ</div><h2 ref={editHeadingRef} tabIndex={-1} className="programmatic-focus-target">Редактировать стадии и переходы</h2></div></div>
      <p className="workflow-scope-note">Каждая правка проходит проверку всего графа и затронутых активностей. Завершающая стадия закреплена последней; из неё нельзя добавлять переходы.</p>
      {scheme && !loading && <>
        <div className="workflow-operation-picker" role="group" aria-label="Действие со схемой">
          {(Object.keys(operationLabels) as WorkflowOperation[]).map((action) => <button key={action} type="button" disabled={editorLocked} className={`${operation === action ? 'selected' : ''}${action === 'delete' || action === 'removeTransition' ? ' danger' : ''}`} aria-pressed={operation === action} onClick={() => { setOperation(action); setExtraTransitions([]); setNewLabel(''); setNewStageKey(''); setReplacementKey(''); setSplitTransitionKey(''); setTargetOrdinal(''); setTransitionFrom(''); setTransitionTo(''); setTransitionKey(''); resetPreview(); }}>{operationLabels[action]}</button>)}
        </div>
        {(operation === 'rename' || operation === 'delete' || operation === 'reorder') && <label className="field workflow-single-field"><span>Стадия</span><select disabled={editorLocked} value={stageKey} onChange={(event) => { setStageKey(event.target.value); setReplacementKey(''); setNewLabel(''); setTargetOrdinal(''); setExtraTransitions([]); resetPreview(); }}>
          {editableStages.map((stage) => <option key={stage.key} value={stage.key}>{stage.label} · {stage.key}</option>)}
        </select></label>}
        {operation === 'rename' && <label className="field workflow-single-field"><span>Новое название</span><input disabled={editorLocked} value={newLabel} maxLength={120} onChange={(event) => { setNewLabel(event.target.value); resetPreview(); }} placeholder="Введите новое название" /></label>}
        {operation === 'delete' && <label className="field workflow-single-field"><span>Куда перенести активности этой стадии</span><select disabled={editorLocked} value={replacementKey} onChange={(event) => { setReplacementKey(event.target.value); resetPreview(); }}><option value="">Выберите соседнюю стадию</option>{adjacentStages.map((stage) => <option key={stage.key} value={stage.key}>{stage.label} · {stage.key}</option>)}</select></label>}
        {operation === 'reorder' && <label className="field workflow-single-field"><span>Новая позиция (завершающая стадия остаётся последней)</span><select disabled={editorLocked} value={targetOrdinal} onChange={(event) => { setTargetOrdinal(event.target.value); resetPreview(); }}><option value="">Выберите позицию</option>{editableStages.map((stage, index) => <option key={stage.key} value={index + 1}>{index + 1}. {stage.label}</option>)}</select></label>}
        {operation === 'addStage' && <>
          <div className="workflow-edit-fields">
            <label className="field"><span>Ключ новой стадии</span><input disabled={editorLocked} value={newStageKey} maxLength={80} pattern="[a-z][a-z0-9_]*" onChange={(event) => { setNewStageKey(event.target.value); resetPreview(); }} placeholder="например, pilot" /></label>
            <label className="field"><span>Название новой стадии</span><input disabled={editorLocked} value={newLabel} maxLength={120} onChange={(event) => { setNewLabel(event.target.value); resetPreview(); }} placeholder="Введите название" /></label>
          </div>
          <label className="field workflow-single-field"><span>Вставить вместо перехода</span><select disabled={editorLocked} value={splitTransitionKey} onChange={(event) => { setSplitTransitionKey(event.target.value); resetPreview(); }}><option value="">Выберите переход</option>{transitionsForSelection.map((edge) => <option key={edgeKey(edge.from, edge.to)} value={edgeKey(edge.from, edge.to)}>{stageLabel(scheme, edge.from)} → {stageLabel(scheme, edge.to)}</option>)}</select></label>
          <p className="workflow-delete-note">Выбранная связь заменится двумя: в новую стадию и из неё. Стадия получит позицию сразу после источника перехода. Привязку инструкции после применения проверьте отдельно.</p>
        </>}
        {operation === 'addTransition' && <div className="workflow-edit-fields">
          <label className="field"><span>Из стадии</span><select disabled={editorLocked} value={transitionFrom} onChange={(event) => { setTransitionFrom(event.target.value); setTransitionTo(''); resetPreview(); }}><option value="">Выберите источник</option>{editableStages.map((stage) => <option key={stage.key} value={stage.key}>{stage.label}</option>)}</select></label>
          <label className="field"><span>В стадию</span><select disabled={editorLocked} value={transitionTo} onChange={(event) => { setTransitionTo(event.target.value); resetPreview(); }}><option value="">Выберите назначение</option>{addTransitionTargets.map((stage) => <option key={stage.key} value={stage.key}>{stage.label}{stage.terminal ? ' · завершение' : ''}</option>)}</select></label>
          <p className="workflow-delete-note">Из завершающей стадии исходящие переходы заблокированы. Недостижимые маршруты покажет предпросмотр.</p>
        </div>}
        {operation === 'removeTransition' && <>
          <label className="field workflow-single-field"><span>Удалить переход</span><select disabled={editorLocked} value={transitionKey} onChange={(event) => { setTransitionKey(event.target.value); resetPreview(); }}><option value="">Выберите переход</option>{transitionsForSelection.map((edge) => <option key={edgeKey(edge.from, edge.to)} value={edgeKey(edge.from, edge.to)}>{stageLabel(scheme, edge.from)} → {stageLabel(scheme, edge.to)}</option>)}</select></label>
          <p className="workflow-delete-note">Удаление связи может сделать стадию недостижимой до завершения. Такой граф будет заблокирован предпросмотром.</p>
        </>}
        {operation === 'delete' && <>
          <p className="workflow-delete-note">Закрытые активности тоже появятся в списке. Перенос стадии не открывает закрытую активность и не меняет её исход.</p>
          {!!routeRepairOptions.length && <fieldset className="workflow-route-repair"><legend>Переходы после удаления</legend><p>Удаление разрывает связи этой стадии. Выберите новые переходы, которые сохранят нужные ветки маршрута. Они не добавляются автоматически.</p>{routeRepairOptions.map((edge) => <label key={edge.key}><input type="checkbox" disabled={editorLocked} checked={extraTransitions.includes(edge.key)} onChange={(event) => {
            setExtraTransitions((current) => event.target.checked ? [...current, edge.key] : current.filter((key) => key !== edge.key));
            resetPreview();
          }} /><span>{stageLabel(scheme, edge.from)} <i aria-hidden="true">→</i> {stageLabel(scheme, edge.to)}</span></label>)}</fieldset>}
        </>}
        <div className="workflow-actions">{previewBusy && <button className="secondary" type="button" onClick={resetPreview}>Отменить запрос</button>}<button className="primary" type="button" disabled={!canPreview || previewBusy || applyBusy || loading} onClick={() => void requestPreview()}>{previewBusy ? 'Строим предпросмотр…' : 'Показать граф и активности'}</button></div>
      </>}
    </section>

    {preview && <section className="panel workflow-preview-panel" aria-live="polite">
      <div className="section-top"><div><div className="eyebrow">ПРЕДПРОСМОТР · РЕВИЗИЯ {preview.revision}</div><h2>Активности и последствия</h2></div><button className="text-button" type="button" disabled={applyBusy || previewBusy} onClick={() => { resetPreview(); requestAnimationFrame(() => editHeadingRef.current?.focus()); }}>Отменить правку</button></div>
      <div className="workflow-impact-counts">
        <div><b>{preview.counts.total}</b><span>всего проверено</span></div><div><b>{preview.counts.open}</b><span>открытых</span></div><div><b>{preview.counts.closed}</b><span>закрытых</span></div>
        {operation === 'delete' && <><div><b>{preview.counts.changedOpen}</b><span>открытых перенесут</span></div><div><b>{preview.counts.changedClosed}</b><span>закрытых перенесут</span></div></>}
      </div>
      {operation === 'delete' && <p className="workflow-mapping-summary">Явное соответствие: <b>{selectedStage?.label ?? stageKey}</b> → <b>{stageLabel(scheme!, replacementKey)}</b>. В списке показаны все найденные вузовские активности.</p>}
      {operation !== 'delete' && <p className="workflow-mapping-summary">Активности останутся на своих стадиях; изменение касается названия, порядка или связей маршрута.</p>}
      <div className="workflow-after"><b>Маршрут после изменения</b><div>{orderScheme(preview.stages).map((stage) => {
        const next = preview.transitions.filter((transition) => transition.from === stage.key).map((transition) => stageLabel(preview, transition.to));
        const instruction = stageInstruction(stage.key);
        return <span className="workflow-after-stage" key={stage.key}><strong>{stage.label}</strong><small>{next.length ? `Далее: ${next.join(' · ')}` : stage.terminal ? 'Завершение маршрута' : 'Нет следующих переходов'}</small><small className={`workflow-instruction-status ${instruction.state}`}>{instruction.label}</small></span>;
      })}</div></div>
      {preview.blockers.length > 0 && <div className="workflow-blockers" role="alert"><b>Изменение пока нельзя применить</b>{preview.blockers.map((blocker, index) => <p key={`${blocker.code}:${index}`}>{blocker.message}{blocker.activityId && <small> · Активность {blocker.activityId}</small>}</p>)}</div>}
      {preview.impactedActivities.length ? <div className="workflow-impact-list" aria-label="Затронутые активности">
        {preview.impactedActivities.map((activity) => {
          const title = visibleWorkflowLabel(activity.title);
          const ownerName = visibleWorkflowLabel(activity.ownerName);
          const activityStatus = activity.closed ? 'Закрыта' : 'Открыта';
          return <article className="workflow-impact-row" key={activity.id}>
          <div className="workflow-impact-main"><b>{title ?? `Активность ${activity.id.slice(0, 8)}`}</b><small>{ownerName ? `${ownerName} · ` : ''}{activity.id} · {activity.stageLabel} · {activityStatus}</small></div>
          <div className="workflow-impact-move"><span>{activity.stageLabel}</span><i aria-hidden="true">→</i>{activity.targetStageLabel ? <strong>{activity.targetStageLabel}</strong> : <em>Нужно выбрать соответствие</em>}</div>
          {activity.closed && <span className="workflow-closed-tag">Закрыта · исход сохранён</span>}
        </article>;
        })}
      </div> : <p className="muted-copy">Активностей, связанных с этой правкой, нет.</p>}
      {preview.canApply && <div className="workflow-confirm">
        <label><input type="checkbox" disabled={applyBusy} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>Я проверил новый маршрут и список затронутых активностей. Применить изменение ко всем вузам.</span></label>
        <button className="primary" type="button" disabled={!confirmed || applyBusy} onClick={() => void applyPreview()}>{applyBusy ? 'Применяем…' : 'Подтвердить и применить'}</button>
      </div>}
    </section>}
  </div>;
}
