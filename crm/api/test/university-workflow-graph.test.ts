import assert from 'node:assert/strict';
import test from 'node:test';
import { addWorkflowTransition, insertWorkflowStageOnTransition, moveWorkflowStage, removeWorkflowTransition } from '../../web/src/university-workflow-graph.ts';

const stages = [
  { key: 'contact', label: 'Контакт', ordinal: 1, terminal: false },
  { key: 'meeting', label: 'Встреча', ordinal: 2, terminal: false },
  { key: 'closed', label: 'Завершено', ordinal: 3, terminal: true },
];
const transitions = [{ from: 'contact', to: 'meeting' }, { from: 'meeting', to: 'closed' }];

test('reordering keeps ordinals contiguous and the terminal stage last', () => {
  const reordered = moveWorkflowStage(stages, 'meeting', 1);
  assert.deepEqual(reordered.map(({ key, ordinal }) => [key, ordinal]), [['meeting', 1], ['contact', 2], ['closed', 3]]);
  assert.equal(reordered.at(-1)?.terminal, true);
});

test('adding a stage splits the selected edge and inserts it before the terminal stage', () => {
  const graph = insertWorkflowStageOnTransition(stages, transitions, { key: 'pilot', label: 'Пилот', ordinal: 1, terminal: false }, transitions[1]);
  assert.deepEqual(graph.stages.map(({ key, ordinal, terminal }) => [key, ordinal, terminal]), [
    ['contact', 1, false], ['meeting', 2, false], ['pilot', 3, false], ['closed', 4, true],
  ]);
  assert.deepEqual(graph.transitions, [
    { from: 'contact', to: 'meeting' }, { from: 'meeting', to: 'pilot' }, { from: 'pilot', to: 'closed' },
  ]);
});

test('ordinary transitions can be added and removed from the candidate graph', () => {
  const withShortcut = addWorkflowTransition(transitions, { from: 'contact', to: 'closed' });
  assert.equal(withShortcut.length, 3);
  assert.deepEqual(removeWorkflowTransition(withShortcut, { from: 'contact', to: 'closed' }), transitions);
});
