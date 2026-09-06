import { z } from 'zod';

export const GOAL_STATE_VERSION = 4;

const nonEmptyString = z.string().trim().min(1);

export const goalStatusSchema = z.enum([
  'active',
  'paused',
  'completed',
  'cancelled',
]);

export const bindingStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export const goalCriterionSchema = z.object({
  id: nonEmptyString,
  text: nonEmptyString,
});

export const goalBindingSchema = z.object({
  goalID: nonEmptyString,
  sessionGeneration: z.number().int().positive(),
  revision: z.number().int().positive(),
  boardRunID: nonEmptyString,
  taskID: nonEmptyString,
  boardGeneration: z.number().int().nonnegative(),
  status: bindingStatusSchema,
  reconciled: z.boolean(),
  superseded: z.boolean(),
});

export const goalEvidenceSchema = z.object({
  goalID: nonEmptyString,
  sessionGeneration: z.number().int().positive(),
  criterionID: nonEmptyString,
  revision: z.number().int().positive(),
  boardRunID: nonEmptyString,
  taskID: nonEmptyString,
  boardGeneration: z.number().int().nonnegative(),
  passed: z.boolean(),
  contradicts: z.boolean(),
  superseded: z.boolean(),
});

export const goalVerificationAssignmentSchema = z.object({
  goalID: nonEmptyString,
  sessionGeneration: z.number().int().positive(),
  criterionID: nonEmptyString,
  revision: z.number().int().positive(),
  boardRunID: nonEmptyString,
  taskID: nonEmptyString,
  boardGeneration: z.number().int().nonnegative(),
  consumed: z.boolean(),
  superseded: z.boolean(),
});

export const goalRecordSchema = z.object({
  id: nonEmptyString,
  sessionGeneration: z.number().int().positive(),
  objective: nonEmptyString,
  requiredCriteria: z.array(goalCriterionSchema).min(1),
  revision: z.number().int().positive(),
  status: goalStatusSchema,
  recordVersion: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
  bindings: z.array(goalBindingSchema),
  verificationAssignments: z
    .array(goalVerificationAssignmentSchema)
    .default([]),
  evidence: z.array(goalEvidenceSchema),
  completionBoardRunID: nonEmptyString.optional(),
});

export const goalSessionStateSchema = z
  .object({
    version: z.literal(GOAL_STATE_VERSION),
    sessionGeneration: z.number().int().nonnegative(),
    boardRunID: nonEmptyString.nullable(),
    boardRunGeneration: z.number().int().nonnegative(),
    retiredBoardRunIDs: z.array(nonEmptyString),
    goal: goalRecordSchema.nullable(),
  })
  .superRefine((state, context) => {
    if (
      state.goal &&
      state.goal.sessionGeneration !== state.sessionGeneration
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Goal session generation must match its containing state',
        path: ['goal', 'sessionGeneration'],
      });
    }
  });

export const createGoalInputSchema = z.object({
  objective: nonEmptyString,
  requiredCriteria: z.array(nonEmptyString).min(1),
});

export const reviseGoalInputSchema = createGoalInputSchema;

export type GoalStatus = z.infer<typeof goalStatusSchema>;
export type GoalBindingStatus = z.infer<typeof bindingStatusSchema>;
export type GoalCriterion = z.infer<typeof goalCriterionSchema>;
export type GoalBinding = z.infer<typeof goalBindingSchema>;
export type GoalEvidence = z.infer<typeof goalEvidenceSchema>;
export type GoalVerificationAssignment = z.infer<
  typeof goalVerificationAssignmentSchema
>;
export type GoalRecord = z.infer<typeof goalRecordSchema>;
export type GoalSessionState = z.infer<typeof goalSessionStateSchema>;
export type CreateGoalInput = z.infer<typeof createGoalInputSchema>;
export type ReviseGoalInput = z.infer<typeof reviseGoalInputSchema>;
