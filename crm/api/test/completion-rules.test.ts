import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHonestCompletion } from '../src/completion-rules.js';

const corporatePlan = {
  agreed: { scope: 'Два кейса', startDate: '2026-10-05', endDate: '2026-10-25', acceptanceCriteria: 'Приняты по протоколу' },
  approval: { status: 'approved' as const, evidenceReference: 'PROTOCOL-7', evidenceSource: 'Протокол заказчика', note: null },
};
const input = (overrides: Partial<Parameters<typeof assertHonestCompletion>[0]> = {}) => ({
  activityKind: 'individual' as const, routeVersion: 'v2', fromStage: 'lms_handoff', targetStage: 'result',
  hasCurrentStageClosureOutcome: false, hasLearningCompletedFact: false, corporatePlan: null,
  ...overrides,
});

test('individual result requires an LMS completion fact or an explicit current-stage refusal/cancellation', () => {
  assert.throws(() => assertHonestCompletion(input()), { code: 'individual_completion_evidence_required' });
  assert.throws(() => assertHonestCompletion(input({ hasLearningCompletedFact: false })), { code: 'individual_completion_evidence_required' });
  assert.doesNotThrow(() => assertHonestCompletion(input({ hasLearningCompletedFact: true })));
  assert.doesNotThrow(() => assertHonestCompletion(input({ hasCurrentStageClosureOutcome: true })));
});

test('corporate completion needs an evidenced agreement or an explicit current-stage closure outcome', () => {
  assert.throws(() => assertHonestCompletion(input({ activityKind: 'corporate', targetStage: 'closed' })), { code: 'corporate_completion_evidence_required' });
  assert.throws(() => assertHonestCompletion(input({ activityKind: 'corporate', targetStage: 'closed', corporatePlan: { ...corporatePlan, agreed: { ...corporatePlan.agreed, endDate: null } } })), { code: 'corporate_completion_evidence_required' });
  assert.doesNotThrow(() => assertHonestCompletion(input({ activityKind: 'corporate', targetStage: 'closed', corporatePlan })));
  assert.doesNotThrow(() => assertHonestCompletion(input({ activityKind: 'corporate', targetStage: 'closed', hasCurrentStageClosureOutcome: true })));
});

test('legacy individual and non-terminal transitions keep their existing workflow behavior', () => {
  assert.doesNotThrow(() => assertHonestCompletion(input({ routeVersion: 'legacy' })));
  assert.doesNotThrow(() => assertHonestCompletion(input({ targetStage: 'exceptions' })));
});
