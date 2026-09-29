import { DomainError, type ActivityKind, type CorporatePlan } from './domain.js';

export interface CompletionEvidence {
  activityKind: ActivityKind;
  routeVersion: string;
  fromStage: string;
  targetStage: string;
  hasCurrentStageClosureOutcome: boolean;
  hasLearningCompletedFact: boolean;
  corporatePlan: Pick<CorporatePlan, 'agreed' | 'approval'> | null;
}

/** Enforce only the result evidence represented by the current project contract. */
export function assertHonestCompletion(evidence: CompletionEvidence): void {
  const { activityKind, routeVersion, targetStage, hasCurrentStageClosureOutcome, hasLearningCompletedFact, corporatePlan } = evidence;

  if (activityKind === 'corporate' && targetStage === 'closed') {
    if (hasCurrentStageClosureOutcome) return;
    const agreed = corporatePlan?.agreed;
    const approval = corporatePlan?.approval;
    const hasAgreement = Boolean(
      agreed?.scope?.trim() && agreed.startDate && agreed.endDate && agreed.acceptanceCriteria?.trim()
      && approval?.status === 'approved' && approval.evidenceReference?.trim() && approval.evidenceSource?.trim(),
    );
    if (!hasAgreement) {
      throw new DomainError(409, 'corporate_completion_evidence_required', 'Для успешного завершения компании зафиксируйте согласованный объём, даты, критерии приёмки и источник подтверждения. Для отказа или отмены запишите отдельный итог с причиной.');
    }
  }

  if (activityKind === 'individual' && routeVersion === 'v2' && targetStage === 'result') {
    if (!hasCurrentStageClosureOutcome && !hasLearningCompletedFact) {
      throw new DomainError(409, 'individual_completion_evidence_required', 'Перед итогом сопровождения запишите подтверждённое завершение обучения из LMS либо явный отказ/отмену с причиной. Принятие запроса LMS не подтверждает обучение.');
    }
  }
}
