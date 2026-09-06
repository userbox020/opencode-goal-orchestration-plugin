import { describe, expect, mock, test } from 'bun:test';
import { createV1InterviewSessionRuntime } from './runtime';

describe('v1 interview session runtime', () => {
  test('keeps SDK calls nested under client.session', async () => {
    const session = {
      messages: mock(async () => ({ data: [{ info: { role: 'user' } }] })),
      prompt: mock(async () => ({})),
      promptAsync: mock(async () => ({})),
      update: mock(async () => ({})),
    };
    const client = { session };
    const runtime = createV1InterviewSessionRuntime({
      client,
    } as never);

    await expect(runtime.messages('ses_1')).resolves.toEqual([
      { info: { role: 'user' } },
    ]);
    await runtime.notify('ses_1', 'ready');
    await runtime.continue('ses_1', 'next', {
      providerID: 'openai',
      modelID: 'gpt-5',
    });
    await runtime.rename('ses_1', 'Interview: app');

    expect(session.messages).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
    expect(session.prompt).toHaveBeenCalledWith({
      path: { id: 'ses_1' },
      body: { noReply: true, parts: [{ type: 'text', text: 'ready' }] },
    });
    expect(session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: 'ses_1' },
        body: expect.objectContaining({
          agent: 'orchestrator',
          model: { providerID: 'openai', modelID: 'gpt-5' },
        }),
      }),
    );
    expect(session.update).toHaveBeenCalledWith({
      path: { id: 'ses_1' },
      body: { title: 'Interview: app' },
    });
  });
});
