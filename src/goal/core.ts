import { z } from 'zod';
import {
  type CreateGoalInput,
  createGoalInputSchema,
  type GoalBinding,
  type GoalBindingStatus,
  type GoalEvidence,
  type GoalRecord,
  type GoalVerificationAssignment,
  type ReviseGoalInput,
  reviseGoalInputSchema,
} from './schema';
import {
  GoalStateVersionConflictError,
  GoalStore,
  type GoalStoreOptions,
  type GoalVersionCheck,
} from './store';

const terminalBindingStatuses = new Set<GoalBindingStatus>([
  'completed',
  'failed',
  'cancelled',
]);

const runtimeBindingIdentitySchema = z.object({
  goalID: z.string().trim().min(1),
  sessionGeneration: z.number().int().positive(),
  revision: z.number().int().positive(),
  boardRunID: z.string().trim().min(1),
  taskID: z.string().trim().min(1),
  boardGeneration: z.number().int().nonnegative(),
});

const runtimeBindingInputSchema = runtimeBindingIdentitySchema.extend({
  status: z
    .enum(['pending', 'running', 'completed', 'failed', 'cancelled'])
    .default('pending'),
});

const runtimeBindingUpdateInputSchema = runtimeBindingIdentitySchema.extend({
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
});

const runtimeEvidenceInputSchema = runtimeBindingIdentitySchema.extend({
  criterionID: z.string().trim().min(1),
  passed: z.boolean(),
  contradicts: z.boolean().default(false),
});

const runtimeEvidenceBatchInputSchema = z.object({
  items: z.array(runtimeEvidenceInputSchema).min(1),
  requireGoalCompletion: z.boolean().default(false),
});

const runtimeVerificationAssignmentInputSchema =
  runtimeBindingIdentitySchema.extend({
    criterionID: z.string().trim().min(1),
  });

const boardRunFenceSchema = z.object({
  boardRunID: z.string().trim().min(1).nullable(),
  boardRunGeneration: z.number().int().nonnegative(),
});

const boardRunRehydrationInputSchema = z.object({
  boardRunID: z.string().trim().min(1),
  expected: boardRunFenceSchema,
});

export type RuntimeBindingIdentity = z.infer<
  typeof runtimeBindingIdentitySchema
>;
export type RuntimeBindingInput = z.input<typeof runtimeBindingInputSchema>;
export type RuntimeBindingUpdateInput = z.infer<
  typeof runtimeBindingUpdateInputSchema
>;
export type RuntimeEvidenceInput = z.input<typeof runtimeEvidenceInputSchema>;
export type RuntimeEvidenceBatchInput = z.input<
  typeof runtimeEvidenceBatchInputSchema
>;
export type RuntimeVerificationAssignmentInput = z.infer<
  typeof runtimeVerificationAssignmentInputSchema
>;
export type BoardRunFence = z.infer<typeof boardRunFenceSchema>;
export type BoardRunRehydrationInput = z.infer<
  typeof boardRunRehydrationInputSchema
>;

export interface GoalRecoverySnapshot {
  goal: GoalRecord | null;
  boardRunFence: BoardRunFence;
}

export interface GoalCoreOptions extends GoalStoreOptions {
  idGenerator?: () => string;
}

export interface GoalContinuationDecision {
  action: 'continue' | 'wait' | 'stop';
  reason: string;
}

export interface GoalContext {
  context: string;
  continuation: GoalContinuationDecision;
}

export type GoalSnapshotCriterionStatus =
  | 'pending'
  | 'verified'
  | 'contradicted';

export interface GoalSnapshotCriterion {
  id: string;
  text: string;
  status: GoalSnapshotCriterionStatus;
}

export type GoalSnapshot =
  | {
      apiVersion: 1;
      state: 'no-goal';
    }
  | {
      apiVersion: 1;
      state: 'goal';
      goal: {
        id: string;
        objective: string;
        status: GoalRecord['status'];
        revision: number;
        recordVersion: number;
        epoch: number;
        progress: {
          verified: number;
          total: number;
          percent: number;
        };
        criteria: GoalSnapshotCriterion[];
      };
    };

export interface GoalCommands {
  status(): GoalRecord | null;
  versionCheck(): GoalVersionCheck | null;
  create(
    input: CreateGoalInput,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord>;
  createIfAbsent(input: CreateGoalInput): Promise<GoalRecord | null>;
  pause(expected?: GoalVersionCheck): Promise<GoalRecord>;
  resume(expected?: GoalVersionCheck): Promise<GoalRecord>;
  revise(
    input: ReviseGoalInput,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord>;
  clear(expected?: GoalVersionCheck): Promise<GoalRecord>;
  renderGoalContext(): GoalContext;
  readSnapshot(): GoalSnapshot;
}

export interface GoalRuntimeObserver {
  boardRunFence(): BoardRunFence;
  readRecoverySnapshot(): GoalRecoverySnapshot;
  rehydrateBoardRun(
    input: BoardRunRehydrationInput,
  ): Promise<GoalRecord | null>;
  bindRuntimeTask(
    input: RuntimeBindingInput,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord>;
  updateRuntimeBinding(
    input: RuntimeBindingUpdateInput,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord>;
  reconcileRuntimeBinding(
    identity: RuntimeBindingIdentity,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord>;
  assignRuntimeVerification(
    input: RuntimeVerificationAssignmentInput,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord>;
  recordRuntimeEvidence(
    input: RuntimeEvidenceInput,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord>;
  finalizeRuntimeEvidenceBatch(
    input: RuntimeEvidenceBatchInput,
  ): Promise<GoalRecord>;
}

export interface GoalRuntimeComposition {
  commands: GoalCommands;
  observer: GoalRuntimeObserver;
}

export class GoalRevisionConflictError extends Error {
  constructor() {
    super('Runtime update belongs to a superseded goal revision or identity');
    this.name = 'GoalRevisionConflictError';
  }
}

export class GoalNotFoundError extends Error {
  constructor() {
    super('No goal exists for this session');
    this.name = 'GoalNotFoundError';
  }
}

export class GoalLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalLifecycleError';
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function updateVersion(goal: GoalRecord): void {
  goal.recordVersion += 1;
  goal.epoch += 1;
}

function criterionID(goal: GoalRecord, value: string): string | undefined {
  const exact = goal.requiredCriteria.find(
    (criterion) => criterion.id === value,
  );
  if (exact) return exact.id;
  const textMatches = goal.requiredCriteria.filter(
    (criterion) => criterion.text === value,
  );
  return textMatches.length === 1 ? textMatches[0]?.id : undefined;
}

function hasBindingIdentity(
  binding: RuntimeBindingIdentity,
  identity: RuntimeBindingIdentity,
): boolean {
  return (
    binding.goalID === identity.goalID &&
    binding.sessionGeneration === identity.sessionGeneration &&
    binding.revision === identity.revision &&
    binding.boardRunID === identity.boardRunID &&
    binding.taskID === identity.taskID &&
    binding.boardGeneration === identity.boardGeneration
  );
}

function currentBindings(
  goal: GoalRecord,
  boardRunID: string | null,
): GoalBinding[] {
  return goal.bindings.filter(
    (binding) =>
      binding.goalID === goal.id &&
      binding.sessionGeneration === goal.sessionGeneration &&
      binding.revision === goal.revision &&
      binding.boardRunID === boardRunID &&
      !binding.superseded,
  );
}

function isTerminal(binding: GoalBinding): boolean {
  return terminalBindingStatuses.has(binding.status);
}

function hasVerificationAssignment(
  assignments: GoalVerificationAssignment[],
  evidence: GoalEvidence,
): boolean {
  return assignments.some(
    (assignment) =>
      !assignment.superseded &&
      assignment.consumed &&
      assignment.criterionID === evidence.criterionID &&
      hasBindingIdentity(assignment, evidence),
  );
}

function eligibleEvidence(
  goal: GoalRecord,
  boardRunID: string | null,
): GoalEvidence[] {
  if (goal.status === 'completed') {
    boardRunID = goal.completionBoardRunID ?? boardRunID;
  }
  const bindings = currentBindings(goal, boardRunID);
  return goal.evidence.filter(
    (item) =>
      item.goalID === goal.id &&
      item.sessionGeneration === goal.sessionGeneration &&
      item.revision === goal.revision &&
      item.boardRunID === boardRunID &&
      !item.superseded &&
      hasVerificationAssignment(goal.verificationAssignments, item) &&
      bindings.some(
        (binding) =>
          hasBindingIdentity(binding, item) &&
          binding.status === 'completed' &&
          binding.reconciled,
      ),
  );
}

function criterionStatus(
  criterion: GoalRecord['requiredCriteria'][number],
  evidence: GoalEvidence[],
): GoalSnapshotCriterionStatus {
  if (
    evidence.some(
      (item) => item.criterionID === criterion.id && item.contradicts,
    )
  ) {
    return 'contradicted';
  }
  if (
    evidence.some((item) => item.criterionID === criterion.id && item.passed)
  ) {
    return 'verified';
  }
  return 'pending';
}

function canComplete(goal: GoalRecord, boardRunID: string | null): boolean {
  if (goal.status !== 'active') return false;
  if (!boardRunID) return false;
  const bindings = currentBindings(goal, boardRunID);
  const evidence = eligibleEvidence(goal, boardRunID);

  if (
    goal.verificationAssignments.some(
      (assignment) =>
        !assignment.superseded &&
        !assignment.consumed &&
        bindings.some((binding) => hasBindingIdentity(binding, assignment)),
    )
  )
    return false;

  const hasPassingEvidence = goal.requiredCriteria.every(
    (criterion) => criterionStatus(criterion, evidence) === 'verified',
  );
  if (!hasPassingEvidence) return false;

  return bindings.every((binding) => isTerminal(binding) && binding.reconciled);
}

function auditRuntimeEvidence(
  goal: GoalRecord,
  boardRunID: string | null,
): boolean {
  if (!canComplete(goal, boardRunID)) return false;
  goal.status = 'completed';
  if (boardRunID) goal.completionBoardRunID = boardRunID;
  return true;
}

function canTransitionBinding(
  previous: GoalBindingStatus,
  next: GoalBindingStatus,
): boolean {
  if (previous === next) return true;
  if (terminalBindingStatuses.has(previous)) return false;
  if (previous === 'running') return terminalBindingStatuses.has(next);
  return next === 'running' || terminalBindingStatuses.has(next);
}

function continuation(
  goal: GoalRecord | null,
  boardRunID: string | null,
): GoalContinuationDecision {
  if (!goal) return { action: 'stop', reason: 'no-goal' };
  if (goal.status === 'paused') return { action: 'wait', reason: 'paused' };
  if (goal.status === 'completed') {
    return { action: 'stop', reason: 'completed' };
  }
  if (goal.status === 'cancelled') {
    return { action: 'stop', reason: 'cancelled' };
  }
  if (
    currentBindings(goal, boardRunID).some((binding) => !binding.reconciled)
  ) {
    return { action: 'wait', reason: 'awaiting-binding-reconciliation' };
  }
  return { action: 'continue', reason: 'active' };
}

/** Host-agnostic durable goal lifecycle and fenced runtime audit surface. */
class GoalCore implements GoalCommands {
  readonly store: GoalStore;
  private readonly idGenerator: () => string;

  constructor(sessionID: string, options: GoalCoreOptions = {}) {
    this.store = new GoalStore(sessionID, options);
    this.idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  status(): GoalRecord | null {
    return clone(this.store.read().goal);
  }

  versionCheck(): GoalVersionCheck | null {
    const state = this.store.read();
    const goal = state.goal;
    if (!goal) return null;
    return {
      goalID: goal.id,
      sessionGeneration: state.sessionGeneration,
      recordVersion: goal.recordVersion,
      epoch: goal.epoch,
    };
  }

  async create(
    input: CreateGoalInput,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord> {
    const parsed = createGoalInputSchema.parse(input);
    const state = await this.store.update(expected, (current) => {
      if (
        current.goal &&
        current.goal.status !== 'completed' &&
        current.goal.status !== 'cancelled'
      ) {
        throw new GoalLifecycleError('An active goal already exists');
      }
      current.goal = this.initializeGoal(current, parsed);
    });
    return this.requireGoal(state.goal);
  }

  async createIfAbsent(input: CreateGoalInput): Promise<GoalRecord | null> {
    if (this.store.read().goal) return null;
    const parsed = createGoalInputSchema.parse(input);

    let created = false;
    const state = await this.store.update(undefined, (current) => {
      if (current.goal) return;
      current.goal = this.initializeGoal(current, parsed);
      created = true;
    });
    return created ? this.requireGoal(state.goal) : null;
  }

  async pause(expected?: GoalVersionCheck): Promise<GoalRecord> {
    return this.transition('paused', expected);
  }

  async resume(expected?: GoalVersionCheck): Promise<GoalRecord> {
    return this.transition('active', expected);
  }

  async revise(
    input: ReviseGoalInput,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord> {
    const parsed = reviseGoalInputSchema.parse(input);
    const state = await this.store.update(expected, (current) => {
      const goal = this.requireGoal(current.goal);
      if (goal.status === 'completed' || goal.status === 'cancelled') {
        throw new GoalLifecycleError('A terminal goal cannot be revised');
      }
      goal.objective = parsed.objective;
      goal.requiredCriteria = parsed.requiredCriteria.map((text, index) => ({
        id: `criterion-${index + 1}`,
        text,
      }));
      goal.revision += 1;
      for (const binding of goal.bindings) binding.superseded = true;
      for (const assignment of goal.verificationAssignments) {
        assignment.superseded = true;
      }
      updateVersion(goal);
    });
    return this.requireGoal(state.goal);
  }

  async clear(expected?: GoalVersionCheck): Promise<GoalRecord> {
    return this.transition('cancelled', expected);
  }

  async runtimeBindRuntimeTask(
    input: RuntimeBindingInput,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord> {
    const parsed = runtimeBindingInputSchema.parse(input);
    const state = await this.store.update(expected, (current) => {
      const goal = this.requireRuntimeGoal(current.goal);
      this.assertCurrentIdentity(goal, current.boardRunID, parsed);
      const taskBindings = goal.bindings.filter(
        (binding) =>
          binding.goalID === parsed.goalID &&
          binding.sessionGeneration === parsed.sessionGeneration &&
          binding.revision === parsed.revision &&
          binding.boardRunID === current.boardRunID &&
          binding.taskID === parsed.taskID,
      );
      if (
        taskBindings.some(
          (binding) => binding.boardGeneration > parsed.boardGeneration,
        )
      ) {
        throw new GoalRevisionConflictError();
      }
      const existing = currentBindings(goal, current.boardRunID).find(
        (binding) => hasBindingIdentity(binding, parsed),
      );
      if (existing) {
        this.transitionBinding(existing, parsed.status);
      } else {
        for (const binding of taskBindings) {
          if (binding.boardGeneration < parsed.boardGeneration) {
            binding.superseded = true;
          }
        }
        goal.bindings.push({
          ...parsed,
          reconciled: false,
          superseded: false,
        });
      }
      updateVersion(goal);
      auditRuntimeEvidence(goal, current.boardRunID);
    });
    return this.requireGoal(state.goal);
  }

  async runtimeUpdateRuntimeBinding(
    input: RuntimeBindingUpdateInput,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord> {
    const parsed = runtimeBindingUpdateInputSchema.parse(input);
    const state = await this.store.update(expected, (current) => {
      const goal = this.requireObservableGoal(current.goal);
      this.assertCurrentIdentity(goal, current.boardRunID, parsed);
      const binding = this.findCurrentBinding(goal, current.boardRunID, parsed);
      this.transitionBinding(binding, parsed.status);
      updateVersion(goal);
      auditRuntimeEvidence(goal, current.boardRunID);
    });
    return this.requireGoal(state.goal);
  }

  async runtimeReconcileRuntimeBinding(
    identity: RuntimeBindingIdentity,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord> {
    const parsed = runtimeBindingIdentitySchema.parse(identity);
    const state = await this.store.update(expected, (current) => {
      const goal = this.requireObservableGoal(current.goal);
      this.assertCurrentIdentity(goal, current.boardRunID, parsed);
      const binding = this.findCurrentBinding(goal, current.boardRunID, parsed);
      if (!isTerminal(binding)) {
        throw new GoalLifecycleError(
          'Only terminal goal tasks may be reconciled',
        );
      }
      binding.reconciled = true;
      updateVersion(goal);
      auditRuntimeEvidence(goal, current.boardRunID);
    });
    return this.requireGoal(state.goal);
  }

  async runtimeRecordRuntimeEvidence(
    input: RuntimeEvidenceInput,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord> {
    const parsed = runtimeEvidenceInputSchema.parse(input);
    const state = await this.store.update(expected, (current) => {
      const goal = this.requireObservableGoal(current.goal);
      this.assertCurrentIdentity(goal, current.boardRunID, parsed);
      const binding = this.findCurrentBinding(goal, current.boardRunID, parsed);
      if (binding.status !== 'completed' || !binding.reconciled) {
        throw new GoalLifecycleError(
          'Runtime evidence requires a reconciled completed goal task',
        );
      }
      const resolvedCriterionID = criterionID(goal, parsed.criterionID);
      if (!resolvedCriterionID) {
        throw new GoalLifecycleError(
          `Unknown required criterion: ${parsed.criterionID}`,
        );
      }
      const assignment = goal.verificationAssignments.find(
        (candidate) =>
          !candidate.superseded &&
          candidate.criterionID === resolvedCriterionID &&
          hasBindingIdentity(candidate, parsed),
      );
      if (!assignment) {
        throw new GoalLifecycleError(
          'Runtime evidence requires an explicit Goal verification assignment',
        );
      }
      const existing = goal.evidence.find(
        (candidate) =>
          !candidate.superseded &&
          candidate.criterionID === resolvedCriterionID &&
          hasBindingIdentity(candidate, parsed),
      );
      if (existing) {
        if (
          existing.passed !== parsed.passed ||
          existing.contradicts !== parsed.contradicts
        ) {
          throw new GoalRevisionConflictError();
        }
        return;
      }
      const evidence: GoalEvidence = {
        ...parsed,
        criterionID: resolvedCriterionID,
        superseded: false,
      };
      assignment.consumed = true;
      goal.evidence.push(evidence);
      updateVersion(goal);
      auditRuntimeEvidence(goal, current.boardRunID);
    });
    return this.requireGoal(state.goal);
  }

  async runtimeFinalizeRuntimeEvidenceBatch(
    input: RuntimeEvidenceBatchInput,
  ): Promise<GoalRecord> {
    const parsed = runtimeEvidenceBatchInputSchema.parse(input);
    const state = await this.store.update(undefined, (current) => {
      const goal = this.requireGoal(current.goal);
      const itemKeys = new Set<string>();
      let changed = false;

      for (const item of parsed.items) {
        this.assertCurrentIdentity(goal, current.boardRunID, item);
        const binding = this.findCurrentBinding(goal, current.boardRunID, item);
        if (binding.status !== 'completed') {
          throw new GoalLifecycleError(
            'Runtime evidence finalization requires completed bindings',
          );
        }
        const resolvedCriterionID = criterionID(goal, item.criterionID);
        if (!resolvedCriterionID) {
          throw new GoalLifecycleError(
            `Unknown required criterion: ${item.criterionID}`,
          );
        }
        const itemKey = [
          item.goalID,
          item.sessionGeneration,
          item.revision,
          item.boardRunID,
          item.taskID,
          item.boardGeneration,
          resolvedCriterionID,
        ].join(':');
        if (itemKeys.has(itemKey)) throw new GoalRevisionConflictError();
        itemKeys.add(itemKey);
        const assignments = goal.verificationAssignments.filter(
          (candidate) =>
            !candidate.superseded &&
            candidate.criterionID === resolvedCriterionID &&
            hasBindingIdentity(candidate, item),
        );
        const assignment = assignments[0];
        if (assignments.length !== 1 || !assignment) {
          throw new GoalLifecycleError(
            'Runtime evidence finalization requires one verification assignment',
          );
        }
        const existing = goal.evidence.find(
          (candidate) =>
            !candidate.superseded &&
            candidate.criterionID === resolvedCriterionID &&
            hasBindingIdentity(candidate, item),
        );
        if (existing) {
          if (
            existing.passed !== item.passed ||
            existing.contradicts !== item.contradicts ||
            !binding.reconciled ||
            !assignment.consumed
          ) {
            throw new GoalRevisionConflictError();
          }
          continue;
        }
        if (goal.status === 'completed' || goal.status === 'cancelled') {
          throw new GoalLifecycleError(
            'Runtime evidence cannot be added to a terminal Goal',
          );
        }
        if (assignment.consumed) {
          throw new GoalRevisionConflictError();
        }
        binding.reconciled = true;
        assignment.consumed = true;
        goal.evidence.push({
          ...item,
          criterionID: resolvedCriterionID,
          superseded: false,
        });
        changed = true;
      }

      if (changed) updateVersion(goal);
      auditRuntimeEvidence(goal, current.boardRunID);
      if (parsed.requireGoalCompletion && goal.status !== 'completed') {
        throw new GoalLifecycleError(
          'Runtime evidence batch did not complete the Goal',
        );
      }
    });
    return this.requireGoal(state.goal);
  }

  async runtimeAssignRuntimeVerification(
    input: RuntimeVerificationAssignmentInput,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord> {
    const parsed = runtimeVerificationAssignmentInputSchema.parse(input);
    const state = await this.store.update(expected, (current) => {
      const goal = this.requireRuntimeGoal(current.goal);
      this.assertCurrentIdentity(goal, current.boardRunID, parsed);
      this.findCurrentBinding(goal, current.boardRunID, parsed);
      const resolvedCriterionID = criterionID(goal, parsed.criterionID);
      if (!resolvedCriterionID) {
        throw new GoalLifecycleError(
          `Unknown required criterion: ${parsed.criterionID}`,
        );
      }
      const existing = goal.verificationAssignments.find(
        (candidate) =>
          !candidate.superseded &&
          candidate.criterionID === resolvedCriterionID &&
          hasBindingIdentity(candidate, parsed),
      );
      if (existing) return;
      goal.verificationAssignments.push({
        ...parsed,
        criterionID: resolvedCriterionID,
        consumed: false,
        superseded: false,
      });
      updateVersion(goal);
    });
    return this.requireGoal(state.goal);
  }

  renderGoalContext(): GoalContext {
    const state = this.store.read();
    const goal = clone(state.goal);
    if (!goal) {
      return {
        context: 'Goal: none',
        continuation: continuation(null, state.boardRunID),
      };
    }
    const evidence = eligibleEvidence(goal, state.boardRunID);
    const lines = [
      `Goal: ${goal.objective}`,
      `Status: ${goal.status}`,
      `Revision: ${goal.revision}`,
      'Required criteria:',
      ...goal.requiredCriteria.map((criterion) => {
        const result = criterionStatus(criterion, evidence);
        const renderedResult =
          result === 'contradicted'
            ? 'contradicted'
            : result === 'verified'
              ? 'passing'
              : 'pending';
        return `- [${renderedResult}] ${criterion.id}: ${criterion.text}`;
      }),
      `Bindings: ${
        currentBindings(goal, state.boardRunID)
          .slice()
          .sort((left, right) => {
            const taskOrder = left.taskID.localeCompare(right.taskID);
            return taskOrder || left.boardGeneration - right.boardGeneration;
          })
          .map((binding) => {
            const reconciliation = binding.reconciled
              ? 'reconciled'
              : 'unreconciled';
            return `${binding.taskID}@${binding.boardGeneration}:${binding.status}:${reconciliation}`;
          })
          .join(', ') || 'none'
      }`,
    ];
    return {
      context: lines.join('\n'),
      continuation: continuation(goal, state.boardRunID),
    };
  }

  readSnapshot(): GoalSnapshot {
    const state = this.store.read();
    const goal = state.goal;
    if (!goal) return { apiVersion: 1, state: 'no-goal' };

    const evidence = eligibleEvidence(goal, state.boardRunID);
    const criteria = goal.requiredCriteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      status: criterionStatus(criterion, evidence),
    }));
    const verified = criteria.filter(
      (criterion) => criterion.status === 'verified',
    ).length;
    const total = criteria.length;

    return {
      apiVersion: 1,
      state: 'goal',
      goal: {
        id: goal.id,
        objective: goal.objective,
        status: goal.status,
        revision: goal.revision,
        recordVersion: goal.recordVersion,
        epoch: goal.epoch,
        progress: {
          verified,
          total,
          percent: Math.round((verified / total) * 100),
        },
        criteria,
      },
    };
  }

  private async transition(
    status: 'active' | 'paused' | 'cancelled',
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord> {
    const state = await this.store.update(expected, (current) => {
      const goal = this.requireGoal(current.goal);
      if (goal.status === 'completed' || goal.status === 'cancelled') {
        throw new GoalLifecycleError('A terminal goal cannot change lifecycle');
      }
      goal.status = status;
      if (status === 'active') auditRuntimeEvidence(goal, current.boardRunID);
      updateVersion(goal);
    });
    return this.requireGoal(state.goal);
  }

  private requireGoal(goal: GoalRecord | null): GoalRecord {
    if (!goal) throw new GoalNotFoundError();
    return goal;
  }

  private initializeGoal(
    state: { sessionGeneration: number },
    input: CreateGoalInput,
  ): GoalRecord {
    state.sessionGeneration += 1;
    return {
      id: this.idGenerator(),
      sessionGeneration: state.sessionGeneration,
      objective: input.objective,
      requiredCriteria: input.requiredCriteria.map((text, index) => ({
        id: `criterion-${index + 1}`,
        text,
      })),
      revision: 1,
      status: 'active',
      recordVersion: 0,
      epoch: 0,
      bindings: [],
      verificationAssignments: [],
      evidence: [],
    };
  }

  private requireRuntimeGoal(goal: GoalRecord | null): GoalRecord {
    const current = this.requireGoal(goal);
    if (current.status !== 'active') {
      throw new GoalLifecycleError('Runtime updates require an active goal');
    }
    return current;
  }

  private requireObservableGoal(goal: GoalRecord | null): GoalRecord {
    const current = this.requireGoal(goal);
    if (current.status === 'completed' || current.status === 'cancelled') {
      throw new GoalLifecycleError(
        'Runtime observations require a non-terminal goal',
      );
    }
    return current;
  }

  boardRunFence(): BoardRunFence {
    const state = this.store.read();
    return {
      boardRunID: state.boardRunID,
      boardRunGeneration: state.boardRunGeneration,
    };
  }

  readRecoverySnapshot(): GoalRecoverySnapshot {
    const state = this.store.read();
    return clone({
      goal: state.goal,
      boardRunFence: {
        boardRunID: state.boardRunID,
        boardRunGeneration: state.boardRunGeneration,
      },
    });
  }

  async runtimeRehydrateBoardRun(
    input: BoardRunRehydrationInput,
  ): Promise<GoalRecord | null> {
    const parsed = boardRunRehydrationInputSchema.parse(input);
    const state = await this.store.update(undefined, (current) => {
      if (
        current.boardRunID !== parsed.expected.boardRunID ||
        current.boardRunGeneration !== parsed.expected.boardRunGeneration
      ) {
        throw new GoalRevisionConflictError();
      }
      if (current.boardRunID === parsed.boardRunID) return;
      if (current.retiredBoardRunIDs.includes(parsed.boardRunID)) {
        throw new GoalRevisionConflictError();
      }
      const previousBoardRunID = current.boardRunID;
      if (current.boardRunID) {
        current.retiredBoardRunIDs.push(current.boardRunID);
      }
      current.boardRunID = parsed.boardRunID;
      current.boardRunGeneration += 1;
      const goal = current.goal;
      if (!goal) return;
      // Historical completion proof is immutable; only live work is re-fenced.
      if (goal.status === 'completed') {
        if (!goal.completionBoardRunID && previousBoardRunID) {
          goal.completionBoardRunID = previousBoardRunID;
        }
        return;
      }
      for (const binding of goal.bindings) {
        if (!binding.superseded) binding.superseded = true;
      }
      for (const evidence of goal.evidence) {
        if (!evidence.superseded) evidence.superseded = true;
      }
      for (const assignment of goal.verificationAssignments) {
        if (!assignment.superseded) assignment.superseded = true;
      }
      updateVersion(goal);
    });
    return clone(state.goal);
  }

  private assertCurrentIdentity(
    goal: GoalRecord,
    boardRunID: string | null,
    identity: RuntimeBindingIdentity,
  ): void {
    if (
      identity.goalID !== goal.id ||
      identity.sessionGeneration !== goal.sessionGeneration ||
      identity.revision !== goal.revision ||
      identity.boardRunID !== boardRunID
    ) {
      throw new GoalRevisionConflictError();
    }
  }

  private findCurrentBinding(
    goal: GoalRecord,
    boardRunID: string | null,
    identity: RuntimeBindingIdentity,
  ): GoalBinding {
    const binding = currentBindings(goal, boardRunID).find((item) =>
      hasBindingIdentity(item, identity),
    );
    if (!binding) {
      throw new GoalRevisionConflictError();
    }
    return binding;
  }

  private transitionBinding(
    binding: GoalBinding,
    status: GoalBindingStatus,
  ): void {
    if (!canTransitionBinding(binding.status, status)) {
      throw new GoalLifecycleError(
        `Invalid goal task lifecycle transition: ${binding.status} to ${status}`,
      );
    }
    binding.status = status;
  }
}

class GoalRuntimeObserverImpl implements GoalRuntimeObserver {
  constructor(private readonly core: GoalCore) {}

  boardRunFence(): BoardRunFence {
    return this.core.boardRunFence();
  }

  readRecoverySnapshot(): GoalRecoverySnapshot {
    return this.core.readRecoverySnapshot();
  }

  rehydrateBoardRun(
    input: BoardRunRehydrationInput,
  ): Promise<GoalRecord | null> {
    return this.core.runtimeRehydrateBoardRun(input);
  }

  bindRuntimeTask(
    input: RuntimeBindingInput,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord> {
    return this.core.runtimeBindRuntimeTask(input, expected);
  }

  updateRuntimeBinding(
    input: RuntimeBindingUpdateInput,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord> {
    return this.core.runtimeUpdateRuntimeBinding(input, expected);
  }

  reconcileRuntimeBinding(
    identity: RuntimeBindingIdentity,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord> {
    return this.core.runtimeReconcileRuntimeBinding(identity, expected);
  }

  assignRuntimeVerification(
    input: RuntimeVerificationAssignmentInput,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord> {
    return this.core.runtimeAssignRuntimeVerification(input, expected);
  }

  recordRuntimeEvidence(
    input: RuntimeEvidenceInput,
    expected?: GoalVersionCheck,
  ): Promise<GoalRecord> {
    return this.core.runtimeRecordRuntimeEvidence(input, expected);
  }

  finalizeRuntimeEvidenceBatch(
    input: RuntimeEvidenceBatchInput,
  ): Promise<GoalRecord> {
    return this.core.runtimeFinalizeRuntimeEvidenceBatch(input);
  }
}

/** Creates the command surface and its private runtime-authority capability. */
export function createGoalRuntime(
  sessionID: string,
  options: GoalCoreOptions = {},
): GoalRuntimeComposition {
  const core = new GoalCore(sessionID, options);
  const commands: GoalCommands = {
    status: () => core.status(),
    versionCheck: () => core.versionCheck(),
    create: (input, expected) => core.create(input, expected),
    createIfAbsent: (input) => core.createIfAbsent(input),
    pause: (expected) => core.pause(expected),
    resume: (expected) => core.resume(expected),
    revise: (input, expected) => core.revise(input, expected),
    clear: (expected) => core.clear(expected),
    renderGoalContext: () => core.renderGoalContext(),
    readSnapshot: () => core.readSnapshot(),
  };
  return {
    commands,
    observer: new GoalRuntimeObserverImpl(core),
  };
}

export { GoalStateVersionConflictError };
