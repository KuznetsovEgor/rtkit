export type WorkflowStageDraft = { key: string; label: string; ordinal: number; terminal: boolean };
export type WorkflowTransitionDraft = { from: string; to: string };

export function moveWorkflowStage(stages: WorkflowStageDraft[], key: string, ordinal: number) {
  const ordered = [...stages].sort((a, b) => a.ordinal - b.ordinal);
  const terminal = ordered.find((stage) => stage.terminal);
  const movable = ordered.filter((stage) => !stage.terminal);
  const from = movable.findIndex((stage) => stage.key === key);
  if (from < 0 || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > movable.length) return ordered;
  const [stage] = movable.splice(from, 1);
  movable.splice(ordinal - 1, 0, stage);
  return [...movable, ...(terminal ? [terminal] : [])].map((item, index) => ({ ...item, ordinal: index + 1 }));
}

export function insertWorkflowStageOnTransition(
  stages: WorkflowStageDraft[],
  transitions: WorkflowTransitionDraft[],
  stage: WorkflowStageDraft,
  split: WorkflowTransitionDraft,
) {
  const ordered = [...stages].sort((a, b) => a.ordinal - b.ordinal);
  const splitIndex = ordered.findIndex((item) => item.key === split.from);
  const withoutSplit = transitions.filter((edge) => edge.from !== split.from || edge.to !== split.to);
  const nextStages = [...ordered];
  nextStages.splice(splitIndex + 1, 0, { ...stage, terminal: false });
  return {
    stages: nextStages.map((item, index) => ({ ...item, ordinal: index + 1 })),
    transitions: [...withoutSplit, { from: split.from, to: stage.key }, { from: stage.key, to: split.to }],
  };
}

export function addWorkflowTransition(transitions: WorkflowTransitionDraft[], edge: WorkflowTransitionDraft) {
  return [...transitions, edge];
}

export function removeWorkflowTransition(transitions: WorkflowTransitionDraft[], edge: WorkflowTransitionDraft) {
  return transitions.filter((item) => item.from !== edge.from || item.to !== edge.to);
}
