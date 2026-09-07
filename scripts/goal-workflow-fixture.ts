import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null
    ? (value as UnknownRecord)
    : undefined;
}

function sameEvidenceIdentity(
  left: UnknownRecord,
  right: UnknownRecord,
): boolean {
  return (
    left.goalID === right.goalID &&
    left.sessionGeneration === right.sessionGeneration &&
    left.revision === right.revision &&
    left.boardRunID === right.boardRunID &&
    left.taskID === right.taskID &&
    left.boardGeneration === right.boardGeneration
  );
}

function hasDurableCompletion(value: unknown, objective: string): boolean {
  const state = asRecord(value);
  if (!state) throw new Error('Durable Goal state is malformed');
  if (state.goal === null) return false;
  const goal = asRecord(state.goal);
  if (!goal) throw new Error('Durable Goal record is malformed');
  if (goal.objective !== objective) {
    throw new Error('Durable Goal objective does not match the fixture');
  }
  if (goal.status !== 'completed') return false;
  if (
    typeof goal.id !== 'string' ||
    typeof goal.sessionGeneration !== 'number' ||
    typeof goal.revision !== 'number' ||
    typeof goal.completionBoardRunID !== 'string' ||
    !goal.completionBoardRunID ||
    !Array.isArray(goal.requiredCriteria) ||
    goal.requiredCriteria.length === 0 ||
    !Array.isArray(goal.bindings) ||
    !Array.isArray(goal.verificationAssignments) ||
    !Array.isArray(goal.evidence)
  ) {
    throw new Error('Completed durable Goal record is malformed');
  }

  const currentIdentity = (item: UnknownRecord) =>
    item.goalID === goal.id &&
    item.sessionGeneration === goal.sessionGeneration &&
    item.revision === goal.revision &&
    item.boardRunID === goal.completionBoardRunID &&
    item.superseded === false;
  const bindings = goal.bindings.map(asRecord);
  const assignments = goal.verificationAssignments.map(asRecord);
  const evidence = goal.evidence.map(asRecord);
  if (
    bindings.some((item) => !item) ||
    assignments.some((item) => !item) ||
    evidence.some((item) => !item)
  ) {
    throw new Error('Completed durable Goal proof arrays are malformed');
  }

  const currentBindings = bindings.filter((item): item is UnknownRecord =>
    Boolean(item && currentIdentity(item)),
  );
  if (
    currentBindings.length === 0 ||
    currentBindings.some(
      (binding) =>
        !['completed', 'failed', 'cancelled'].includes(
          String(binding.status),
        ) || binding.reconciled !== true,
    )
  ) {
    throw new Error('Durable Goal has unreconciled current bindings');
  }

  const eligibleEvidence = evidence.filter((item): item is UnknownRecord =>
    Boolean(
      item &&
        currentIdentity(item) &&
        assignments.some(
          (assignment) =>
            assignment &&
            currentIdentity(assignment) &&
            assignment.consumed === true &&
            assignment.criterionID === item.criterionID &&
            sameEvidenceIdentity(assignment, item),
        ) &&
        currentBindings.some(
          (binding) =>
            binding.status === 'completed' &&
            binding.reconciled === true &&
            sameEvidenceIdentity(binding, item),
        ),
    ),
  );

  for (const criterionValue of goal.requiredCriteria) {
    const criterion = asRecord(criterionValue);
    if (!criterion || typeof criterion.id !== 'string' || !criterion.id) {
      throw new Error('Durable Goal criterion is malformed');
    }
    const criterionEvidence = eligibleEvidence.filter(
      (item) => item.criterionID === criterion.id,
    );
    if (criterionEvidence.some((item) => item.contradicts === true)) {
      throw new Error(`Durable Goal criterion ${criterion.id} is contradicted`);
    }
    if (
      !criterionEvidence.some(
        (item) => item.passed === true && item.contradicts === false,
      )
    ) {
      throw new Error(
        `Durable Goal criterion ${criterion.id} lacks consumed passing evidence`,
      );
    }
  }
  return true;
}

/** A local scripted model, not a test of an external model's reasoning. */
export async function startGoalWorkflowFixture(
  workspace: string,
  xdgDataHome: string,
) {
  const artifact = path.join(workspace, 'goal-workflow.txt');
  const objective =
    'Create goal-workflow.txt containing verified fixture, then verify it.';
  let automaticPanelInvoked = false;
  let automaticPanelOrigin = 'unknown';
  let workerLaunched = false;
  let workerDone = false;
  let verifierLaunched = false;
  let verifierDone = false;
  let requests = 0;
  const server = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 4_000_000)
          throw new Error('Fixture request too large');
      }
      if (request.url === '/panel' && request.method === 'POST') {
        automaticPanelInvoked = true;
        const panelRequest = asRecord(JSON.parse(raw));
        if (typeof panelRequest?.url === 'string') {
          automaticPanelOrigin = new URL(panelRequest.url).origin;
        }
        response.writeHead(409).end(
          JSON.stringify({
            error: 'Automatic Goal panel opening is forbidden',
          }),
        );
        return;
      }
      if (request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as {
        stream?: boolean;
        messages: Array<{ role: string; content?: unknown }>;
        tools?: Array<{ function: { name: string } }>;
      };
      if (++requests > 40)
        throw new Error('Fixture model request limit reached');
      const userText = JSON.stringify(
        body.messages.filter((message) => message.role === 'user'),
      );
      const hasToolResult = body.messages.some(
        (message) => message.role === 'tool',
      );
      const hasTool = (name: string) =>
        body.tools?.some((tool) => tool.function.name === name);
      let content = 'Goal fixture';
      let tool: { name: string; arguments: string } | undefined;
      const call = (name: string, args: object) => {
        tool = { name, arguments: JSON.stringify(args) };
      };
      if (userText.includes('FIXTURE_WORKER')) {
        if (!hasToolResult)
          call('write', { filePath: artifact, content: 'verified fixture\n' });
        else {
          workerDone = true;
          content = 'Fixture worker completed.';
        }
      } else if (userText.includes('FIXTURE_VERIFIER')) {
        if (!hasToolResult) call('read', { filePath: artifact });
        else {
          const passed =
            existsSync(artifact) &&
            readFileSync(artifact, 'utf8') === 'verified fixture\n';
          verifierDone = passed;
          content = `<goal_verdict>{"criterionID":"criterion-1","verdict":"${passed ? 'passed' : 'failed'}"}</goal_verdict>`;
        }
      } else if (
        hasTool('task') &&
        JSON.stringify(body.messages).includes('Goal verification:')
      ) {
        if (!workerLaunched) {
          workerLaunched = true;
          call('task', {
            subagent_type: 'fixer',
            background: true,
            description: 'Fixture implementation',
            prompt: 'FIXTURE_WORKER: create the fixture artifact.',
          });
        } else if (workerDone && !verifierLaunched) {
          verifierLaunched = true;
          call('task', {
            subagent_type: 'explorer',
            background: true,
            description: 'Goal verification: criterion-1',
            prompt: 'FIXTURE_VERIFIER: read and verify the fixture artifact.',
          });
        } else content = 'Awaiting reconciled fixture verification.';
      }
      if (tool && !hasTool(tool.name))
        throw new Error(`Fixture requires unavailable tool ${tool.name}`);
      const toolCalls = tool
        ? [
            {
              index: 0,
              id: `fixture-${requests}`,
              type: 'function',
              function: tool,
            },
          ]
        : undefined;
      const finishReason = tool ? 'tool_calls' : 'stop';
      const base = { id: `fixture-${requests}`, created: 1, model: 'fixture' };
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = {
          ...base,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                ...(toolCalls ? { tool_calls: toolCalls } : { content }),
              },
              finish_reason: null,
            },
          ],
        };
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.end(
          `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
        );
      } else {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            ...base,
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content,
                  ...(toolCalls ? { tool_calls: toolCalls } : {}),
                },
                finish_reason: finishReason,
              },
            ],
          }),
        );
      }
    } catch (error) {
      response.writeHead(500).end(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'Fixture failure',
        }),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture listener unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    async verify(host: string) {
      const query = `?directory=${encodeURIComponent(workspace)}`;
      const created = await fetch(`${host}/session${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(10_000),
      });
      if (!created.ok)
        throw new Error(`Fixture session creation failed: ${created.status}`);
      const session = (await created.json()) as { id: string };
      const durableGoalPath = path.join(
        xdgDataHome,
        'opencode',
        'oh-my-opencode-slim',
        'goals',
        `${Buffer.from(session.id).toString('base64url')}.json`,
      );
      const prompt = await fetch(
        `${host}/session/${session.id}/prompt_async${query}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            agent: 'goal',
            model: { providerID: 'fixture', modelID: 'fixture' },
            parts: [{ type: 'text', text: objective }],
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!prompt.ok)
        throw new Error(`Fixture prompt rejected: ${prompt.status}`);
      const deadline = Date.now() + 150_000;
      while (Date.now() < deadline) {
        if (automaticPanelInvoked) {
          throw new Error(
            `Goal panel opened automatically when manual-only behavior was required: ${automaticPanelOrigin}`,
          );
        }
        if (existsSync(durableGoalPath)) {
          const durableState: unknown = JSON.parse(
            readFileSync(durableGoalPath, 'utf8'),
          );
          if (hasDurableCompletion(durableState, objective)) {
            if (
              !workerDone ||
              !verifierDone ||
              !existsSync(artifact) ||
              readFileSync(artifact, 'utf8') !== 'verified fixture\n'
            ) {
              throw new Error(
                'Durable Goal completed without its worker/verifier artifact proof',
              );
            }
            console.log(
              'Packaged Goal workflow passed: automatic creation, worker, verifier, no automatic panel, durable completion.',
            );
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(
        `Packaged Goal workflow timed out waiting for durable completion with no automatic panel (requests=${requests}, worker=${workerDone}, verifier=${verifierDone}, automaticPanel=${automaticPanelInvoked}, durableRecord=${existsSync(durableGoalPath)})`,
      );
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
