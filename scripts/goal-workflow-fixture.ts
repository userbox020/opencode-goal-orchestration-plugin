import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

/** A local scripted model, not a test of an external model's reasoning. */
export async function startGoalWorkflowFixture(workspace: string) {
  const artifact = path.join(workspace, 'goal-workflow.txt');
  const objective =
    'Create goal-workflow.txt containing verified fixture, then verify it.';
  let panelURL: URL | undefined;
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
        panelURL = new URL(JSON.parse(raw).url);
        response.end('{}');
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
        if (panelURL) {
          const result = await fetch(`${panelURL.origin}/api/v1/snapshot`, {
            headers: { Authorization: `Bearer ${panelURL.hash.slice(1)}` },
            signal: AbortSignal.timeout(5_000),
          });
          const snapshot = (await result.json()) as {
            goal?: {
              objective: string;
              status: string;
              progress: { verified: number; total: number };
            };
          };
          if (snapshot.goal?.status === 'completed') {
            if (
              !workerDone ||
              !verifierDone ||
              snapshot.goal.objective !== objective ||
              snapshot.goal.progress.verified !== snapshot.goal.progress.total
            )
              throw new Error(
                'Fixture completed without its worker/verifier proof',
              );
            console.log(
              'Packaged Goal workflow passed: automatic creation, worker, verifier, completed snapshot.',
            );
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(
        `Packaged Goal workflow timed out (requests=${requests}, worker=${workerDone}, verifier=${verifierDone}, panel=${Boolean(panelURL)})`,
      );
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
