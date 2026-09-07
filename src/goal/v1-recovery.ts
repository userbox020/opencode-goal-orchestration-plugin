import type { OpencodeClient } from '@opencode-ai/sdk';
import type { GoalRuntimeComposition, RuntimeEvidenceInput } from './core';
import { parseGoalVerificationVerdict } from './runtime-verification';

export interface V1GoalRecoveryHost {
  client: OpencodeClient;
  directory: string;
}

export type V1GoalRecoveryOutcome =
  | { status: 'recovered'; count: number }
  | { status: 'definitively-invalid'; reason: string }
  | { status: 'inconclusive'; reason: string };

type InvalidOutcome = Exclude<V1GoalRecoveryOutcome, { status: 'recovered' }>;

interface LaunchProvenance {
  taskID: string;
  description: string;
}

type CanonicalLaunchState = 'running' | 'completed';

interface CanonicalLaunch {
  taskID: string;
  state: CanonicalLaunchState;
}

const TASK_ID_PATTERN = '[A-Za-z0-9][A-Za-z0-9._:-]*';
const TASK_ID_MATERIAL = /(?:^|\r?\n)\s*task(?:_| )id:\s*\S+/i;
const TASK_ELEMENT_MATERIAL = /<\/?task(?:\s|>)/i;

function isCanonicalTaskResultEnvelope(value: string): boolean {
  if (
    (value.match(/<task_result>/g) ?? []).length !== 1 ||
    (value.match(/<\/task_result>/g) ?? []).length !== 1
  ) {
    return false;
  }
  return /^<task_result>(?:\r?\n)?[\s\S]*?(?:\r?\n)?<\/task_result>$/.test(
    value,
  );
}

/** Strict parser for persisted Task launch output used only by Goal recovery. */
function parseCanonicalRecoveryLaunch(output: string): CanonicalLaunch | null {
  const canonical = output.trim();
  const xml = new RegExp(
    `^<task id="(${TASK_ID_PATTERN})" state="(running|completed)">\\r?\\n([\\s\\S]*)\\r?\\n<\\/task>$`,
  ).exec(canonical);
  if (xml) {
    const taskID = xml[1];
    const state = xml[2] as CanonicalLaunchState;
    let body = xml[3] ?? '';
    const summary = /^<summary>[^\r\n<>]*<\/summary>\r?\n/.exec(body);
    if (summary) body = body.slice(summary[0].length);
    if (
      !taskID ||
      !isCanonicalTaskResultEnvelope(body) ||
      TASK_ID_MATERIAL.test(body) ||
      TASK_ELEMENT_MATERIAL.test(body)
    ) {
      return null;
    }
    return { taskID, state };
  }

  const stateful = new RegExp(
    `^task_id: (${TASK_ID_PATTERN})\\r?\\nstate: (running|completed)\\r?\\n\\r?\\n([\\s\\S]+)$`,
  ).exec(canonical);
  if (stateful) {
    const taskID = stateful[1];
    const state = stateful[2] as CanonicalLaunchState;
    const result = stateful[3] ?? '';
    if (
      !taskID ||
      !isCanonicalTaskResultEnvelope(result) ||
      TASK_ID_MATERIAL.test(result) ||
      TASK_ELEMENT_MATERIAL.test(result)
    ) {
      return null;
    }
    return { taskID, state };
  }

  const foreground = new RegExp(
    `^task_id: (${TASK_ID_PATTERN}) \\(for resuming to continue this task if needed\\)\\r?\\n\\r?\\n([\\s\\S]+)$`,
  ).exec(canonical);
  if (!foreground) return null;
  const taskID = foreground[1];
  const result = foreground[2] ?? '';
  if (
    !taskID ||
    !isCanonicalTaskResultEnvelope(result) ||
    TASK_ID_MATERIAL.test(result) ||
    TASK_ELEMENT_MATERIAL.test(result)
  ) {
    return null;
  }
  return { taskID, state: 'completed' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function definitivelyInvalid(reason: string): InvalidOutcome {
  return { status: 'definitively-invalid', reason };
}

function inconclusive(reason: string): InvalidOutcome {
  return { status: 'inconclusive', reason };
}

function projectLaunches(
  response: unknown,
  parentSessionID: string,
): LaunchProvenance[] | InvalidOutcome {
  if (!isRecord(response) || !Array.isArray(response.data)) {
    return inconclusive('parent-messages-malformed');
  }
  const launches: LaunchProvenance[] = [];
  for (const message of response.data) {
    if (!isRecord(message) || !isRecord(message.info)) {
      return inconclusive('parent-message-malformed');
    }
    if (message.info.role !== 'assistant') continue;
    if (
      message.info.sessionID !== parentSessionID ||
      !Array.isArray(message.parts)
    ) {
      return inconclusive('parent-message-malformed');
    }
    for (const part of message.parts) {
      if (!isRecord(part) || typeof part.type !== 'string') {
        return inconclusive('parent-message-part-malformed');
      }
      if (part.type !== 'tool' || part.tool !== 'task') continue;
      if (
        !isRecord(part.state) ||
        !isRecord(part.state.input) ||
        typeof part.state.input.description !== 'string' ||
        typeof part.state.output !== 'string'
      ) {
        return inconclusive('parent-task-launch-malformed');
      }
      const launch = parseCanonicalRecoveryLaunch(part.state.output);
      if (!launch) {
        return definitivelyInvalid('parent-task-launch-output-invalid');
      }
      launches.push({
        taskID: launch.taskID,
        description: part.state.input.description,
      });
    }
  }
  return launches;
}

function extractStrictFinalVerdict(
  response: unknown,
  taskID: string,
  criterionID: string,
): true | InvalidOutcome {
  if (!isRecord(response) || !Array.isArray(response.data)) {
    return inconclusive('child-messages-malformed');
  }
  if (response.data.length === 0) {
    return definitivelyInvalid('child-result-missing');
  }
  for (const message of response.data) {
    if (
      !isRecord(message) ||
      !isRecord(message.info) ||
      !Array.isArray(message.parts)
    ) {
      return inconclusive('child-message-malformed');
    }
    for (const part of message.parts) {
      if (!isRecord(part) || typeof part.type !== 'string') {
        return inconclusive('child-message-part-malformed');
      }
    }
  }

  const final = response.data[response.data.length - 1];
  if (
    !isRecord(final) ||
    !isRecord(final.info) ||
    !Array.isArray(final.parts)
  ) {
    return inconclusive('child-final-message-malformed');
  }
  if (
    final.info.role !== 'assistant' ||
    final.info.sessionID !== taskID ||
    !isRecord(final.info.time) ||
    typeof final.info.time.completed !== 'number' ||
    !Number.isFinite(final.info.time.completed) ||
    final.info.error !== undefined
  ) {
    return definitivelyInvalid('child-final-message-not-terminal');
  }

  const textParts: string[] = [];
  for (const part of final.parts) {
    if (!isRecord(part) || part.type !== 'text') continue;
    if (
      typeof part.text !== 'string' ||
      (part.synthetic !== undefined && typeof part.synthetic !== 'boolean')
    ) {
      return inconclusive('child-text-part-malformed');
    }
    if (part.synthetic !== true && part.text) textParts.push(part.text);
  }
  const verdict = parseGoalVerificationVerdict(textParts.join('\n\n'));
  if (
    !verdict ||
    verdict.criterionID !== criterionID ||
    !verdict.passed ||
    verdict.contradicts
  ) {
    return definitivelyInvalid('child-verdict-invalid');
  }
  return true;
}

function identityKey(identity: {
  goalID: string;
  sessionGeneration: number;
  revision: number;
  boardRunID: string;
  taskID: string;
  boardGeneration: number;
}): string {
  return [
    identity.goalID,
    identity.sessionGeneration,
    identity.revision,
    identity.boardRunID,
    identity.taskID,
    identity.boardGeneration,
  ].join(':');
}

/** One-shot all-or-nothing V1 verifier recovery before board rehydration. */
export async function recoverV1GoalBeforeRehydrate(options: {
  runtime: GoalRuntimeComposition;
  client: OpencodeClient;
  directory: string;
  parentSessionID: string;
  nextBoardRunID: string;
}): Promise<V1GoalRecoveryOutcome> {
  try {
    const snapshot = options.runtime.observer.readRecoverySnapshot();
    const { goal, boardRunFence } = snapshot;
    if (!goal) return definitivelyInvalid('goal-missing');
    if (goal.status !== 'active') {
      return definitivelyInvalid('goal-not-active');
    }
    if (
      !boardRunFence.boardRunID ||
      boardRunFence.boardRunID === options.nextBoardRunID
    ) {
      return definitivelyInvalid('old-board-run-missing');
    }

    const isCurrentIdentity = (identity: {
      goalID: string;
      sessionGeneration: number;
      revision: number;
      boardRunID: string;
      superseded: boolean;
    }) =>
      !identity.superseded &&
      identity.goalID === goal.id &&
      identity.sessionGeneration === goal.sessionGeneration &&
      identity.revision === goal.revision &&
      identity.boardRunID === boardRunFence.boardRunID;
    const currentBindings = goal.bindings.filter(isCurrentIdentity);
    const pendingAssignments = goal.verificationAssignments.filter(
      (assignment) => isCurrentIdentity(assignment) && !assignment.consumed,
    );
    if (pendingAssignments.length === 0) {
      return definitivelyInvalid('pending-verification-missing');
    }

    const batch: RuntimeEvidenceInput[] = [];
    const batchBindingKeys = new Set<string>();
    for (const assignment of pendingAssignments) {
      const bindings = currentBindings.filter(
        (binding) =>
          binding.taskID === assignment.taskID &&
          binding.boardGeneration === assignment.boardGeneration,
      );
      if (bindings.length !== 1 || bindings[0]?.status !== 'completed') {
        return definitivelyInvalid('completed-verifier-binding-missing');
      }
      const binding = bindings[0];
      if (
        !goal.requiredCriteria.some(
          (criterion) => criterion.id === assignment.criterionID,
        ) ||
        goal.evidence.some(
          (evidence) =>
            !evidence.superseded &&
            identityKey(evidence) === identityKey(assignment),
        )
      ) {
        return definitivelyInvalid('verification-assignment-conflict');
      }
      batchBindingKeys.add(identityKey(binding));
      batch.push({
        goalID: binding.goalID,
        sessionGeneration: binding.sessionGeneration,
        revision: binding.revision,
        boardRunID: binding.boardRunID,
        taskID: binding.taskID,
        boardGeneration: binding.boardGeneration,
        criterionID: assignment.criterionID,
        passed: true,
        contradicts: false,
      });
    }
    if (
      currentBindings.some(
        (binding) =>
          !binding.reconciled && !batchBindingKeys.has(identityKey(binding)),
      )
    ) {
      return definitivelyInvalid('unassigned-unreconciled-binding');
    }

    const parentResponse = await options.client.session.messages({
      path: { id: options.parentSessionID },
      query: { directory: options.directory },
      throwOnError: true,
    });
    const launches = projectLaunches(parentResponse, options.parentSessionID);
    if (!Array.isArray(launches)) return launches;

    for (const item of batch) {
      const matchingLaunches = launches.filter(
        (launch) => launch.taskID === item.taskID,
      );
      if (
        matchingLaunches.length !== 1 ||
        matchingLaunches[0]?.description !==
          `Goal verification: ${item.criterionID}`
      ) {
        return definitivelyInvalid('parent-task-launch-invalid');
      }
      const childResponse = await options.client.session.get({
        path: { id: item.taskID },
        query: { directory: options.directory },
        throwOnError: true,
      });
      if (!isRecord(childResponse) || !isRecord(childResponse.data)) {
        return inconclusive('child-session-malformed');
      }
      if (
        childResponse.data.id !== item.taskID ||
        childResponse.data.parentID !== options.parentSessionID
      ) {
        return definitivelyInvalid('child-session-identity-invalid');
      }
      const childMessages = await options.client.session.messages({
        path: { id: item.taskID },
        query: { directory: options.directory },
        throwOnError: true,
      });
      const verdict = extractStrictFinalVerdict(
        childMessages,
        item.taskID,
        item.criterionID,
      );
      if (verdict !== true) return verdict;
    }

    await options.runtime.observer.finalizeRuntimeEvidenceBatch({
      items: batch,
      requireGoalCompletion: true,
    });
    return { status: 'recovered', count: batch.length };
  } catch {
    return inconclusive('host-or-persistence-read-failed');
  }
}
