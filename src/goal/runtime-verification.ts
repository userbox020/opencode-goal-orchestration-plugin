import { z } from 'zod';

export const GOAL_VERIFICATION_DESCRIPTION_PREFIX = 'Goal verification: ';
export const GOAL_VERDICT_OPEN_TAG = '<goal_verdict>';
export const GOAL_VERDICT_CLOSE_TAG = '</goal_verdict>';

const goalVerificationVerdictSchema = z
  .object({
    criterionID: z.string().trim().min(1),
    verdict: z.enum(['passed', 'failed', 'contradicted']),
  })
  .strict();

export interface GoalVerificationVerdict {
  criterionID: string;
  passed: boolean;
  contradicts: boolean;
}

export function parseGoalVerificationTaskDescription(
  description: string,
): string | undefined {
  if (!description.startsWith(GOAL_VERIFICATION_DESCRIPTION_PREFIX)) {
    return undefined;
  }
  const criterionID = description.slice(
    GOAL_VERIFICATION_DESCRIPTION_PREFIX.length,
  );
  return criterionID.length > 0 && criterionID.trim() === criterionID
    ? criterionID
    : undefined;
}

export function parseGoalVerificationVerdict(
  result: string | undefined,
): GoalVerificationVerdict | undefined {
  if (!result) return undefined;
  const start = result.indexOf(GOAL_VERDICT_OPEN_TAG);
  if (start < 0 || result.indexOf(GOAL_VERDICT_OPEN_TAG, start + 1) >= 0) {
    return undefined;
  }
  const bodyStart = start + GOAL_VERDICT_OPEN_TAG.length;
  const end = result.indexOf(GOAL_VERDICT_CLOSE_TAG, bodyStart);
  if (end < 0 || result.indexOf(GOAL_VERDICT_CLOSE_TAG, end + 1) >= 0) {
    return undefined;
  }
  try {
    const parsed = goalVerificationVerdictSchema.parse(
      JSON.parse(result.slice(bodyStart, end)),
    );
    return {
      criterionID: parsed.criterionID,
      passed: parsed.verdict === 'passed',
      contradicts: parsed.verdict === 'contradicted',
    };
  } catch {
    return undefined;
  }
}
