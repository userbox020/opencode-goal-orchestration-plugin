import { describe, expect, test } from 'bun:test';
import {
  parseGoalVerificationTaskDescription,
  parseGoalVerificationVerdict,
} from './runtime-verification';

describe('Goal runtime verification contract', () => {
  test('accepts an exact verifier description and strict verdict marker', () => {
    expect(
      parseGoalVerificationTaskDescription('Goal verification: criterion-1'),
    ).toBe('criterion-1');
    expect(
      parseGoalVerificationVerdict(
        'Checked the tests.\n<goal_verdict>{"criterionID":"criterion-1","verdict":"passed"}</goal_verdict>',
      ),
    ).toEqual({
      criterionID: 'criterion-1',
      passed: true,
      contradicts: false,
    });
  });

  test('fails closed for prose, malformed, duplicate, or extended verdicts', () => {
    expect(parseGoalVerificationTaskDescription('verify criterion-1')).toBeUndefined();
    expect(parseGoalVerificationVerdict('criterion-1 passed')).toBeUndefined();
    expect(
      parseGoalVerificationVerdict(
        '<goal_verdict>{"criterionID":"criterion-1","verdict":"passed","claim":true}</goal_verdict>',
      ),
    ).toBeUndefined();
    expect(
      parseGoalVerificationVerdict(
        '<goal_verdict>{"criterionID":"criterion-1","verdict":"passed"}</goal_verdict><goal_verdict>{"criterionID":"criterion-1","verdict":"failed"}</goal_verdict>',
      ),
    ).toBeUndefined();
  });
});
