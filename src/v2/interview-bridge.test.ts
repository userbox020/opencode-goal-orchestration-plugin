import { describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import {
  createV2InterviewBridge,
  INTERVIEW_COMMAND_MARKER,
} from './interview-bridge';

function createContext(overrides?: {
  synthetic?: (input: Record<string, unknown>) => Promise<unknown>;
  update?: (input: Record<string, unknown>) => Promise<unknown>;
}): any {
  return {
    session: {
      hook: mock(async () => ({ dispose() {} })),
      synthetic: overrides?.synthetic,
      update: overrides?.update,
    },
  };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to get free port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

describe('v2 interview bridge', () => {
  test('registers an orchestrator-owned marker command and rewrites only the tail', async () => {
    const directory = `.tmp-v2-interview-${Date.now()}`;
    const synthetic = mock(async () => ({}));
    const update = mock(async () => ({}));
    const bridge = createV2InterviewBridge(
      createContext({ synthetic, update }),
      {
        outputFolder: directory,
      } as never,
    );
    const commands: Record<string, Record<string, unknown>> = {};
    bridge.registerCommand({
      update(name, apply) {
        commands[name] = {};
        apply(commands[name]);
      },
    });

    expect(commands.interview).toMatchObject({
      agent: 'orchestrator',
      template: INTERVIEW_COMMAND_MARKER,
    });

    const earlier = {
      id: 'old',
      role: 'user',
      content: [{ type: 'text', text: 'Earlier context' }],
    };
    const event = {
      sessionID: 'ses_v2',
      agent: 'orchestrator',
      model: {},
      system: [],
      tools: {},
      messages: [
        earlier,
        {
          id: 'tail',
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<omos-interview-command>build a notes app</omos-interview-command>',
            },
          ],
        },
      ],
    };
    const earlierBefore = structuredClone(earlier);
    await bridge.handleContext(event);

    expect(earlier).toEqual(earlierBefore);
    expect(event.messages[1].content[0].text).toContain('build a notes app');
    expect(event.messages[1].content[0].text).toContain('<interview_state>');
    expect(synthetic).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      sessionID: 'ses_v2',
      title: 'Interview: build a notes app',
    });

    bridge.dispose();
    await fs.rm(`${process.cwd()}/${directory}`, {
      recursive: true,
      force: true,
    });
  });

  test('projects text events and removes a deleted session', async () => {
    const bridge = createV2InterviewBridge(createContext());
    await bridge.handleContext({
      sessionID: 'ses_text',
      agent: 'orchestrator',
      model: {},
      system: [],
      tools: {},
      messages: [
        {
          id: 'u',
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
    });
    await bridge.handleEvent({
      type: 'session.next.text.started',
      properties: { sessionID: 'ses_text' },
    });
    await bridge.handleEvent({
      type: 'session.next.text.delta',
      properties: { sessionID: 'ses_text', delta: 'one' },
    });
    await bridge.handleEvent({
      type: 'session.next.text.delta',
      properties: { sessionID: 'ses_text', delta: ' two' },
    });
    expect(bridge.getTranscript('ses_text').at(-1)?.parts?.[0]?.text).toBe(
      'one two',
    );

    await bridge.handleEvent({
      type: 'session.deleted',
      properties: { sessionID: 'ses_text' },
    });
    expect(bridge.getTranscript('ses_text')).toEqual([]);
    bridge.dispose();
  });

  test('shares one configured dashboard across multiple v2 sessions', async () => {
    const directory = `.tmp-v2-dashboard-${Date.now()}`;
    const port = await findFreePort();
    const config = {
      outputFolder: directory,
      dashboard: true,
      port,
    } as never;
    const synthetic1 = mock(async () => ({}));
    const synthetic2 = mock(async () => ({}));
    const bridge1 = createV2InterviewBridge(
      createContext({ synthetic: synthetic1 }),
      config,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const bridge2 = createV2InterviewBridge(
      createContext({ synthetic: synthetic2 }),
      config,
    );

    try {
      const createEvent = (sessionID: string, idea: string) => ({
        sessionID,
        agent: 'orchestrator',
        model: {},
        system: [],
        tools: {},
        messages: [
          {
            id: `${sessionID}-command`,
            role: 'user',
            content: [
              {
                type: 'text',
                text: `<omos-interview-command>${idea}</omos-interview-command>`,
              },
            ],
          },
        ],
      });

      const event1 = createEvent('v2-session-1', 'first dashboard idea');
      const event2 = createEvent('v2-session-2', 'second dashboard idea');
      await bridge1.handleContext(event1);
      await bridge2.handleContext(event2);

      expect(synthetic1.mock.calls[0]?.[0].text).toContain(
        `http://127.0.0.1:${port}/interview/`,
      );
      expect(synthetic2.mock.calls[0]?.[0].text).toContain(
        `http://127.0.0.1:${port}/interview/`,
      );
    } finally {
      await bridge1.dispose();
      await bridge2.dispose();
      await fs.rm(`${process.cwd()}/${directory}`, {
        recursive: true,
        force: true,
      });
    }
  });
});
