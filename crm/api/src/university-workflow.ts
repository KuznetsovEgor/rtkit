import { createHash } from 'node:crypto';
import { DomainError, type UniversityWorkflowChange, type WorkflowStageDraft, type WorkflowTransitionDraft } from './domain.js';

export interface UniversityWorkflowActivitySnapshot {
  id: string;
  title: string;
  ownerName: string;
  ownerSub?: string;
  importOwnerOnly?: boolean;
  organizationId?: string | null;
  payerOrganizationId?: string | null;
  stageKey: string;
  stageLabel: string;
  closed: boolean;
}

export interface UniversityWorkflowState {
  revision: number;
  stages: WorkflowStageDraft[];
  transitions: WorkflowTransitionDraft[];
  activities: UniversityWorkflowActivitySnapshot[];
}

export interface NormalizedUniversityWorkflowChange extends UniversityWorkflowChange {
  stages: WorkflowStageDraft[];
  transitions: WorkflowTransitionDraft[];
  mappings: Record<string, string>;
}

const keyPattern = /^[a-z][a-z0-9_]{0,79}$/;
const cleanText = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export function normalizeUniversityWorkflowChange(input: UniversityWorkflowChange): NormalizedUniversityWorkflowChange {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new DomainError(400, 'invalid_workflow_revision', 'Укажите положительную версию схемы.');
  }
  if (!Array.isArray(input.stages) || input.stages.length < 2 || input.stages.length > 40) {
    throw new DomainError(400, 'invalid_workflow_stages', 'Схема должна содержать от 2 до 40 стадий, включая начальную и завершающую.');
  }
  if (!Array.isArray(input.transitions) || input.transitions.length > 160) {
    throw new DomainError(400, 'invalid_workflow_transitions', 'Схема может содержать не более 160 переходов.');
  }
  if (!input.mappings || typeof input.mappings !== 'object' || Array.isArray(input.mappings)) {
    throw new DomainError(400, 'invalid_workflow_mappings', 'Укажите явное соответствие удаляемых стадий.');
  }

  const stages = input.stages.map((stage) => ({
    key: cleanText(stage.key), label: cleanText(stage.label), ordinal: stage.ordinal, terminal: stage.terminal,
  })).sort((a, b) => a.ordinal - b.ordinal || a.key.localeCompare(b.key));
  const keys = new Set<string>();
  const ordinals = new Set<number>();
  for (const stage of stages) {
    if (!keyPattern.test(stage.key) || stage.key.length > 80) throw new DomainError(400, 'invalid_workflow_stage_key', 'Ключ стадии должен начинаться с латинской буквы и содержать латинские буквы, цифры или _.');
    if (keys.has(stage.key)) throw new DomainError(400, 'duplicate_workflow_stage', 'Ключ стадии должен быть уникальным.');
    if (!stage.label || stage.label.length > 120 || /[\u0000-\u001f\u007f]/.test(stage.label)) throw new DomainError(400, 'invalid_workflow_stage_label', 'Укажите название стадии длиной до 120 символов.');
    if (!Number.isInteger(stage.ordinal) || stage.ordinal < 1 || stage.ordinal > 40 || ordinals.has(stage.ordinal)) throw new DomainError(400, 'invalid_workflow_ordinal', 'Порядок стадий должен быть уникальным числом от 1 до 40.');
    if (typeof stage.terminal !== 'boolean') throw new DomainError(400, 'invalid_workflow_terminal', 'Для каждой стадии укажите, является ли она завершающей.');
    keys.add(stage.key);
    ordinals.add(stage.ordinal);
  }
  if (stages.some((stage, index) => stage.ordinal !== index + 1)) throw new DomainError(400, 'invalid_workflow_ordinal', 'Порядок стадий должен идти подряд, начиная с 1.');
  const terminalStages = stages.filter((stage) => stage.terminal);
  if (terminalStages.length !== 1 || terminalStages[0].ordinal !== stages.length) throw new DomainError(400, 'invalid_workflow_terminal', 'В схеме должна быть одна завершающая стадия, последняя по порядку.');

  const edgeSet = new Set<string>();
  const transitions = input.transitions.map((edge) => ({ from: cleanText(edge.from), to: cleanText(edge.to) }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const outgoing = new Map<string, string[]>();
  for (const edge of transitions) {
    if (!keys.has(edge.from) || !keys.has(edge.to) || edge.from === edge.to) throw new DomainError(400, 'invalid_workflow_edge', 'Переход должен соединять две разные стадии этой схемы.');
    const signature = `${edge.from}\u0000${edge.to}`;
    if (edgeSet.has(signature)) throw new DomainError(400, 'duplicate_workflow_edge', 'Переход в схеме указан несколько раз.');
    edgeSet.add(signature);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const terminalKey = terminalStages[0].key;
  if (outgoing.has(terminalKey)) throw new DomainError(400, 'terminal_workflow_edge', 'Из завершающей стадии нельзя продолжить рабочий маршрут.');
  for (const stage of stages) {
    if (!stage.terminal && !canReachTerminal(stage.key, terminalKey, outgoing)) {
      throw new DomainError(400, 'workflow_terminal_unreachable', `Из стадии «${stage.label}» невозможно дойти до завершающей стадии.`);
    }
  }

  const mappings: Record<string, string> = {};
  for (const [from, to] of Object.entries(input.mappings)) {
    const oldKey = cleanText(from);
    const newKey = cleanText(to);
    if (!keyPattern.test(oldKey) || !keyPattern.test(newKey)) throw new DomainError(400, 'invalid_workflow_mapping', 'Проверьте ключи в соответствии стадий.');
    mappings[oldKey] = newKey;
  }
  return { expectedRevision: input.expectedRevision, stages, transitions, mappings: Object.fromEntries(Object.entries(mappings).sort(([a], [b]) => a.localeCompare(b))) };
}

function canReachTerminal(start: string, terminal: string, outgoing: Map<string, string[]>) {
  const visited = new Set<string>();
  const queue = [...(outgoing.get(start) ?? [])];
  while (queue.length) {
    const key = queue.shift()!;
    if (key === terminal) return true;
    if (visited.has(key)) continue;
    visited.add(key);
    queue.push(...(outgoing.get(key) ?? []));
  }
  return false;
}

function sortedState(state: UniversityWorkflowState) {
  return {
    revision: state.revision,
    stages: [...state.stages].sort((a, b) => a.ordinal - b.ordinal || a.key.localeCompare(b.key)),
    transitions: [...state.transitions].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    activities: [...state.activities].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, stageKey, closed }) => ({ id, stageKey, closed })),
  };
}

export function previewUniversityWorkflow(state: UniversityWorkflowState, rawInput: UniversityWorkflowChange) {
  const input = normalizeUniversityWorkflowChange(rawInput);
  if (input.expectedRevision !== state.revision) throw new DomainError(409, 'workflow_revision_conflict', 'Схема уже изменилась. Обновите её и создайте новый предпросмотр.');
  const currentStageByKey = new Map(state.stages.map((stage) => [stage.key, stage]));
  const nextStageByKey = new Map(input.stages.map((stage) => [stage.key, stage]));
  const removedStages = state.stages.filter((stage) => !nextStageByKey.has(stage.key));
  const blockers: Record<string, unknown>[] = [];
  const validReplacementKeys: Record<string, string[]> = {};
  const currentNeighbors = new Map<string, Set<string>>();
  for (const { from, to } of state.transitions) {
    currentNeighbors.set(from, new Set([...(currentNeighbors.get(from) ?? []), to]));
    currentNeighbors.set(to, new Set([...(currentNeighbors.get(to) ?? []), from]));
  }

  for (const removed of removedStages) {
    const valid = [...(currentNeighbors.get(removed.key) ?? [])].filter((key) => nextStageByKey.has(key)).sort();
    validReplacementKeys[removed.key] = valid;
    const target = input.mappings[removed.key];
    if (!target) blockers.push({ code: 'stage_mapping_required', message: `Выберите стадию для «${removed.label}».`, stageKey: removed.key });
    else if (!nextStageByKey.has(target)) blockers.push({ code: 'mapping_target_missing', message: `Целевая стадия «${target}» отсутствует в новой схеме.`, stageKey: removed.key });
    else if (!valid.includes(target)) blockers.push({ code: 'mapping_target_not_adjacent', message: `Для «${removed.label}» выберите сохранённую соседнюю стадию.`, stageKey: removed.key, targetStageKey: target, validReplacementKeys: valid });
  }
  for (const mappedKey of Object.keys(input.mappings)) {
    if (nextStageByKey.has(mappedKey)) blockers.push({ code: 'mapping_source_not_removed', message: `Стадия «${mappedKey}» остаётся в схеме и не требует переноса.`, stageKey: mappedKey });
  }

  const impactedActivities = state.activities.map((activity) => {
    const stageRetained = nextStageByKey.has(activity.stageKey);
    const targetKey = stageRetained ? activity.stageKey : input.mappings[activity.stageKey] ?? null;
    const target = targetKey ? nextStageByKey.get(targetKey) : undefined;
    const oldStage = currentStageByKey.get(activity.stageKey);
    if (!stageRetained && targetKey && target && oldStage && !(validReplacementKeys[activity.stageKey] ?? []).includes(targetKey)) {
      // The stage-level blocker above is sufficient; keep the affected row visible with its attempted target.
    }
    if (!activity.closed && target?.terminal) blockers.push({ code: 'open_activity_to_terminal', message: 'Открытая активность не может быть перенесена на завершающую стадию.', activityId: activity.id, stageKey: activity.stageKey, targetStageKey: target.key });
    return {
      ...activity,
      targetStageKey: target?.key ?? null,
      targetStageLabel: target?.label ?? null,
      changeRequired: target?.key !== activity.stageKey,
    };
  });

  if (JSON.stringify({ stages: state.stages, transitions: state.transitions }) === JSON.stringify({ stages: input.stages, transitions: input.transitions })) {
    blockers.push({ code: 'workflow_no_changes', message: 'В схеме нет изменений для применения.' });
  }

  const previewToken = createHash('sha256').update(JSON.stringify({ state: sortedState(state), input })).digest('hex');
  const changed = impactedActivities.filter((activity) => activity.changeRequired);
  const openCount = impactedActivities.filter((activity) => !activity.closed).length;
  const closedCount = impactedActivities.length - openCount;
  return {
    kind: 'university', revision: state.revision, previewToken, canApply: blockers.length === 0,
    stages: input.stages, transitions: input.transitions, mappings: input.mappings, validReplacementKeys,
    impactedActivities,
    counts: { total: impactedActivities.length, open: openCount, closed: closedCount, changedOpen: changed.filter((a) => !a.closed).length, changedClosed: changed.filter((a) => a.closed).length },
    blockers,
  };
}
