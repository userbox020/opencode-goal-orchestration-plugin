import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGoalRuntime,
  type GoalRuntimeComposition,
  type RuntimeEvidenceInput,
} from './core';
import {
  recoverV1GoalBeforeRehydrate,
  type V1GoalRecoveryOutcome,
} from './v1-recovery';
import { createGoalSessionRuntimeResolver } from './v1-runtime';

const SESSION_ID = 'goal-parent';
const OLD_RUN_ID = 'old-board-run';
const NEW_RUN_ID = 'new-board-run';

interface RecoveryFixture {
  runtime: GoalRuntimeComposition;
  items: RuntimeEvidenceInput[];
}

async function createFixture(
  root: string,
  criteria = 1,
  reconciled: ReadonlySet<number> = new Set(),
): Promise<RecoveryFixture> {
  const runtime = createGoalRuntime(SESSION_ID, { root });
  await runtime.observer.rehydrateBoardRun({
    boardRunID: OLD_RUN_ID,
    expected: runtime.observer.boardRunFence(),
  });
  const goal = await runtime.commands.create({
    objective: 'Recover verifier evidence',
    requiredCriteria: Array.from(
      { length: criteria },
      (_, index) => `Criterion ${index + 1} passes.`,
    ),
  });
  const items: RuntimeEvidenceInput[] = [];
  for (let index = 1; index <= criteria; index += 1) {
    const identity = {
      goalID: goal.id,
      sessionGeneration: goal.sessionGeneration,
      revision: goal.revision,
      boardRunID: OLD_RUN_ID,
      taskID: `verifier-${index}`,
      boardGeneration: index,
    };
    await runtime.observer.bindRuntimeTask({ ...identity, status: 'running' });
    await runtime.observer.assignRuntimeVerification({
      ...identity,
      criterionID: `criterion-${index}`,
    });
    await runtime.observer.updateRuntimeBinding({
      ...identity,
      status: 'completed',
    });
    if (reconciled.has(index)) {
      await runtime.observer.reconcileRuntimeBinding(identity);
    }
    items.push({
      ...identity,
      criterionID: `criterion-${index}`,
      passed: true,
      contradicts: false,
    });
  }
  return { runtime, items };
}

function verdict(criterionID: string): string {
  return `<goal_verdict>{"criterionID":"${criterionID}","verdict":"passed"}</goal_verdict>`;
}

function statefulLaunchOutput(
  taskID: string,
  state: 'running' | 'completed' = 'running',
): string {
  return [
    `task_id: ${taskID}`,
    `state: ${state}`,
    '',
    '<task_result>',
    state === 'running' ? 'Background task started.' : 'Task completed.',
    '</task_result>',
  ].join('\n');
}

function foregroundLaunchOutput(taskID: string): string {
  return [
    `task_id: ${taskID} (for resuming to continue this task if needed)`,
    '',
    '<task_result>',
    'Task completed.',
    '</task_result>',
  ].join('\n');
}

function xmlLaunchOutput(
  taskID: string,
  state: 'running' | 'completed',
): string {
  return [
    `<task id="${taskID}" state="${state}">`,
    `<summary>${state === 'running' ? 'Background task running' : 'Background task completed'}</summary>`,
    '<task_result>',
    state === 'running' ? 'Background task started.' : 'Task completed.',
    '</task_result>',
    '</task>',
  ].join('\n');
}

function launchPart(
  output: string,
  description = 'Goal verification: criterion-1',
) {
  return {
    type: 'tool',
    tool: 'task',
    state: { input: { description }, output },
  };
}

function recoveryClient(
  options: {
    criteria?: number;
    childMessages?: Record<string, unknown>;
    childParentID?: string;
    parentParts?: readonly unknown[];
    parentResponse?: unknown;
    throwFor?: string;
  } = {},
) {
  const criteria = options.criteria ?? 1;
  return {
    session: {
      get: async ({ path }: { path: { id: string } }) => {
        if (options.throwFor === `get:${path.id}`)
          throw new Error('host failed');
        return {
          data: {
            id: path.id,
            parentID: options.childParentID ?? SESSION_ID,
          },
        };
      },
      messages: async ({ path }: { path: { id: string } }) => {
        if (options.throwFor === path.id) throw new Error('host failed');
        if (path.id === SESSION_ID) {
          return (
            options.parentResponse ?? {
              data: [
                {
                  info: { role: 'assistant', sessionID: SESSION_ID },
                  parts:
                    options.parentParts ??
                    Array.from({ length: criteria }, (_, index) => ({
                      type: 'tool',
                      tool: 'task',
                      state: {
                        input: {
                          description: `Goal verification: criterion-${index + 1}`,
                        },
                        output: statefulLaunchOutput(`verifier-${index + 1}`),
                      },
                    })),
                },
              ],
            }
          );
        }
        const index = Number(path.id.slice('verifier-'.length));
        return (
          options.childMessages?.[path.id] ?? {
            data: [
              {
                info: {
                  role: 'assistant',
                  sessionID: path.id,
                  time: { completed: index },
                },
                parts: [{ type: 'text', text: verdict(`criterion-${index}`) }],
              },
            ],
          }
        );
      },
    },
  } as never;
}

function recover(
  runtime: GoalRuntimeComposition,
  client: never,
): Promise<V1GoalRecoveryOutcome> {
  return recoverV1GoalBeforeRehydrate({
    runtime,
    client,
    directory: '.',
    parentSessionID: SESSION_ID,
    nextBoardRunID: NEW_RUN_ID,
  });
}

function resolver(root: string, client: never) {
  return createGoalSessionRuntimeResolver({
    runtimes: new Map(),
    boardRunID: NEW_RUN_ID,
    createRuntime: (sessionID) => createGoalRuntime(sessionID, { root }),
    recovery: { client, directory: root },
  });
}

describe('V1 pre-rehydrate Goal recovery', () => {
  test.each([false, true])(
    'recovers one complete verifier batch (already reconciled=%s)',
    async (alreadyReconciled) => {
      const root = mkdtempSync(join(tmpdir(), 'omos-goal-recovery-one-'));
      try {
        await createFixture(
          root,
          1,
          alreadyReconciled ? new Set([1]) : new Set(),
        );
        const runtime = await resolver(root, recoveryClient())(SESSION_ID);
        expect(runtime.commands.status()).toMatchObject({
          status: 'completed',
          completionBoardRunID: OLD_RUN_ID,
          evidence: [{ criterionID: 'criterion-1', passed: true }],
          bindings: [{ reconciled: true }],
          verificationAssignments: [{ consumed: true }],
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.each([
    ['line running', statefulLaunchOutput('verifier-1', 'running')],
    ['line completed', statefulLaunchOutput('verifier-1', 'completed')],
    ['foreground completed', foregroundLaunchOutput('verifier-1')],
    ['XML running', xmlLaunchOutput('verifier-1', 'running')],
    ['XML completed', xmlLaunchOutput('verifier-1', 'completed')],
    [
      'XML running without summary',
      [
        '<task id="verifier-1" state="running">',
        '<task_result>Background task started.</task_result>',
        '</task>',
      ].join('\n'),
    ],
  ])('recovers canonical %s launch output', async (_name, output) => {
    const root = mkdtempSync(join(tmpdir(), 'omos-goal-recovery-shape-'));
    try {
      await createFixture(root);
      const runtime = await resolver(
        root,
        recoveryClient({ parentParts: [launchPart(output)] }),
      )(SESSION_ID);
      expect(runtime.commands.status()?.status).toBe('completed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('recovers two criteria in one atomic completion batch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omos-goal-recovery-two-'));
    try {
      await createFixture(root, 2);
      const runtime = await resolver(
        root,
        recoveryClient({ criteria: 2 }),
      )(SESSION_ID);
      expect(runtime.commands.status()?.status).toBe('completed');
      expect(runtime.commands.status()?.evidence).toHaveLength(2);
      expect(
        runtime.commands
          .status()
          ?.verificationAssignments.every((assignment) => assignment.consumed),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('one invalid criterion writes no subset and normally rehydrates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omos-goal-recovery-partial-'));
    try {
      await createFixture(root, 2);
      const client = recoveryClient({
        criteria: 2,
        childMessages: {
          'verifier-2': {
            data: [
              {
                info: {
                  role: 'assistant',
                  sessionID: 'verifier-2',
                  time: { completed: 2 },
                },
                parts: [{ type: 'text', text: 'not a verdict' }],
              },
            ],
          },
        },
      });
      const runtime = await resolver(root, client)(SESSION_ID);
      expect(runtime.observer.boardRunFence().boardRunID).toBe(NEW_RUN_ID);
      expect(runtime.commands.status()).toMatchObject({
        status: 'active',
        evidence: [],
        bindings: [
          { superseded: true, reconciled: false },
          { superseded: true, reconciled: false },
        ],
        verificationAssignments: [
          { superseded: true, consumed: false },
          { superseded: true, consumed: false },
        ],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('paused Goals skip recovery and are normally refenced', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omos-goal-recovery-paused-'));
    try {
      const { runtime: prior } = await createFixture(root);
      await prior.commands.pause();
      const runtime = await resolver(root, recoveryClient())(SESSION_ID);
      expect(runtime.observer.boardRunFence().boardRunID).toBe(NEW_RUN_ID);
      expect(runtime.commands.status()).toMatchObject({
        status: 'paused',
        evidence: [],
        bindings: [{ superseded: true }],
        verificationAssignments: [{ superseded: true, consumed: false }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ['wrong child parent', { childParentID: 'other-parent' }],
    ['missing launch', { parentParts: [] }],
    [
      'duplicate launch',
      {
        parentParts: [
          launchPart(statefulLaunchOutput('verifier-1')),
          launchPart(statefulLaunchOutput('verifier-1')),
        ],
      },
    ],
    [
      'wrong launch description',
      {
        parentParts: [
          launchPart(
            statefulLaunchOutput('verifier-1'),
            'Goal verification: criterion-2',
          ),
        ],
      },
    ],
  ] as const)('rejects %s provenance', async (_name, clientOptions) => {
    const root = mkdtempSync(join(tmpdir(), 'omos-goal-recovery-launch-'));
    try {
      await createFixture(root);
      const runtime = await resolver(
        root,
        recoveryClient(clientOptions),
      )(SESSION_ID);
      expect(runtime.commands.status()).toMatchObject({
        status: 'active',
        evidence: [],
        bindings: [{ superseded: true }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses only the assistant launch when a user message repeats it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omos-goal-recovery-role-'));
    try {
      await createFixture(root);
      const part = launchPart(statefulLaunchOutput('verifier-1'));
      const runtime = await resolver(
        root,
        recoveryClient({
          parentResponse: {
            data: [
              {
                info: { role: 'user', sessionID: SESSION_ID },
                parts: [part],
              },
              {
                info: { role: 'assistant', sessionID: SESSION_ID },
                parts: [part],
              },
            ],
          },
        }),
      )(SESSION_ID);
      expect(runtime.commands.status()?.status).toBe('completed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ['user', 'user'],
    ['system', 'system'],
    ['malformed', undefined],
  ] as const)('rejects a %s-role task launch', async (_name, role) => {
    const root = mkdtempSync(join(tmpdir(), 'omos-goal-recovery-role-'));
    try {
      await createFixture(root);
      const runtime = await resolver(
        root,
        recoveryClient({
          parentResponse: {
            data: [
              {
                info: { role, sessionID: SESSION_ID },
                parts: [
                  launchPart(statefulLaunchOutput('verifier-1', 'running')),
                ],
              },
            ],
          },
        }),
      )(SESSION_ID);
      expect(runtime.commands.status()).toMatchObject({
        status: 'active',
        evidence: [],
        bindings: [{ superseded: true }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    [
      'multiple conflicting IDs',
      [
        'task_id: verifier-1',
        'state: running',
        '',
        '<task_result>',
        'task_id: verifier-2',
        '</task_result>',
      ].join('\n'),
    ],
    [
      'embedded task XML and prose',
      `prior output <task id="verifier-2" state="running">\n${statefulLaunchOutput('verifier-1')}`,
    ],
    [
      'malformed XML envelope',
      [
        '<task id="verifier-1" state="running" extra="true">',
        '<task_result>started</task_result>',
        '</task>',
      ].join('\n'),
    ],
    [
      'non-launch error state',
      statefulLaunchOutput('verifier-1').replace(
        'state: running',
        'state: error',
      ),
    ],
    [
      'non-launch cancelled state',
      xmlLaunchOutput('verifier-1', 'running').replace(
        'state="running"',
        'state="cancelled"',
      ),
    ],
    [
      'trailing ambiguous launch material',
      `${statefulLaunchOutput('verifier-1')}\ntask_id: verifier-2`,
    ],
  ])('rejects %s in task launch output', async (_name, output) => {
    const root = mkdtempSync(join(tmpdir(), 'omos-goal-recovery-output-'));
    try {
      await createFixture(root);
      const runtime = await resolver(
        root,
        recoveryClient({ parentParts: [launchPart(output)] }),
      )(SESSION_ID);
      expect(runtime.commands.status()).toMatchObject({
        status: 'active',
        evidence: [],
        bindings: [{ superseded: true }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    [
      'reasoning-only',
      {
        data: [
          {
            info: {
              role: 'assistant',
              sessionID: 'verifier-1',
              time: { completed: 1 },
            },
            parts: [{ type: 'reasoning', text: verdict('criterion-1') }],
          },
        ],
      },
    ],
    [
      'synthetic-only',
      {
        data: [
          {
            info: {
              role: 'assistant',
              sessionID: 'verifier-1',
              time: { completed: 1 },
            },
            parts: [
              { type: 'text', text: verdict('criterion-1'), synthetic: true },
            ],
          },
        ],
      },
    ],
    [
      'missing final session ID',
      {
        data: [
          {
            info: { role: 'assistant', time: { completed: 1 } },
            parts: [{ type: 'text', text: verdict('criterion-1') }],
          },
        ],
      },
    ],
    [
      'wrong final session ID',
      {
        data: [
          {
            info: {
              role: 'assistant',
              sessionID: 'other',
              time: { completed: 1 },
            },
            parts: [{ type: 'text', text: verdict('criterion-1') }],
          },
        ],
      },
    ],
    [
      'malformed parts',
      {
        data: [
          {
            info: {
              role: 'assistant',
              sessionID: 'verifier-1',
              time: { completed: 1 },
            },
            parts: [null],
          },
        ],
      },
    ],
    [
      'trailing user',
      {
        data: [
          {
            info: {
              role: 'assistant',
              sessionID: 'verifier-1',
              time: { completed: 1 },
            },
            parts: [{ type: 'text', text: verdict('criterion-1') }],
          },
          {
            info: { role: 'user', sessionID: 'verifier-1' },
            parts: [{ type: 'text', text: 'continue' }],
          },
        ],
      },
    ],
    [
      'error result',
      {
        data: [
          {
            info: {
              role: 'assistant',
              sessionID: 'verifier-1',
              time: { completed: 1 },
              error: { name: 'ProviderError' },
            },
            parts: [{ type: 'text', text: verdict('criterion-1') }],
          },
        ],
      },
    ],
    [
      'nonterminal result',
      {
        data: [
          {
            info: { role: 'assistant', sessionID: 'verifier-1' },
            parts: [{ type: 'text', text: verdict('criterion-1') }],
          },
        ],
      },
    ],
    [
      'failed verdict',
      {
        data: [
          {
            info: {
              role: 'assistant',
              sessionID: 'verifier-1',
              time: { completed: 1 },
            },
            parts: [
              {
                type: 'text',
                text: '<goal_verdict>{"criterionID":"criterion-1","verdict":"failed"}</goal_verdict>',
              },
            ],
          },
        ],
      },
    ],
    [
      'duplicate verdict',
      {
        data: [
          {
            info: {
              role: 'assistant',
              sessionID: 'verifier-1',
              time: { completed: 1 },
            },
            parts: [
              {
                type: 'text',
                text: `${verdict('criterion-1')}\n${verdict('criterion-1')}`,
              },
            ],
          },
        ],
      },
    ],
    [
      'mismatched verdict',
      {
        data: [
          {
            info: {
              role: 'assistant',
              sessionID: 'verifier-1',
              time: { completed: 1 },
            },
            parts: [{ type: 'text', text: verdict('criterion-2') }],
          },
        ],
      },
    ],
  ] as const)('rejects %s final evidence', async (_name, childResponse) => {
    const root = mkdtempSync(join(tmpdir(), 'omos-goal-recovery-final-'));
    try {
      const { runtime } = await createFixture(root);
      const outcome = await recover(
        runtime,
        recoveryClient({
          childMessages: { 'verifier-1': childResponse },
        }),
      );
      expect(outcome.status).not.toBe('recovered');
      expect(runtime.commands.status()).toMatchObject({
        status: 'active',
        evidence: [],
        bindings: [{ reconciled: false }],
        verificationAssignments: [{ consumed: false }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ['host exception', recoveryClient({ throwFor: SESSION_ID })],
    [
      'malformed projection',
      recoveryClient({ parentResponse: { data: null } }),
    ],
  ])(
    '%s is inconclusive and does not block rehydrate',
    async (_name, client) => {
      const root = mkdtempSync(join(tmpdir(), 'omos-goal-recovery-host-'));
      try {
        const { runtime: prior } = await createFixture(root);
        expect(await recover(prior, client)).toMatchObject({
          status: 'inconclusive',
        });
        const runtime = await resolver(root, client)(SESSION_ID);
        expect(runtime.observer.boardRunFence().boardRunID).toBe(NEW_RUN_ID);
        expect(runtime.commands.status()).toMatchObject({
          evidence: [],
          bindings: [{ superseded: true }],
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('atomic finalizer rolls back partial completion and retries idempotently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omos-goal-finalizer-'));
    try {
      const { runtime, items } = await createFixture(root, 2);
      await expect(
        runtime.observer.finalizeRuntimeEvidenceBatch({
          items: [items[0] as RuntimeEvidenceInput],
          requireGoalCompletion: true,
        }),
      ).rejects.toThrow('did not complete the Goal');
      expect(runtime.commands.status()).toMatchObject({
        evidence: [],
        bindings: [{ reconciled: false }, { reconciled: false }],
        verificationAssignments: [{ consumed: false }, { consumed: false }],
      });

      await runtime.observer.finalizeRuntimeEvidenceBatch({
        items,
        requireGoalCompletion: true,
      });
      await runtime.observer.finalizeRuntimeEvidenceBatch({
        items,
        requireGoalCompletion: true,
      });
      expect(runtime.commands.status()?.status).toBe('completed');
      expect(runtime.commands.status()?.evidence).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('concurrent recovery creates no duplicate evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omos-goal-recovery-race-'));
    try {
      await createFixture(root);
      const first = createGoalRuntime(SESSION_ID, { root });
      const second = createGoalRuntime(SESSION_ID, { root });
      const client = recoveryClient();
      await Promise.all([recover(first, client), recover(second, client)]);
      expect(first.commands.status()?.status).toBe('completed');
      expect(first.commands.status()?.evidence).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
