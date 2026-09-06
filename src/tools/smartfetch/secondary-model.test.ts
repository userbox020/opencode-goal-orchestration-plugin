import { afterEach, describe, expect, mock, test } from 'bun:test';
import { _testConfig, runSecondaryModelWithFallback } from './secondary-model';
import type { SecondaryModel } from './types';

type PromptStep = {
  text?: string;
  error?: Error;
};

// Mock getClient so internal calls use our mock v2 client.
// The variable is reassigned per-test to control behavior.
let mockV2Client: Record<string, unknown>;
let mockV2Session: {
  abort: ReturnType<typeof mock>;
  create: ReturnType<typeof mock>;
  prompt: ReturnType<typeof mock>;
  delete: ReturnType<typeof mock>;
};
let mockV2Tool: {
  ids: ReturnType<typeof mock>;
};

mock.module('../../utils/opencode-client', () => ({
  getClient: () => mockV2Client,
}));

function createV2ClientMock(
  steps: PromptStep[],
  deleteBehavior?: {
    failTimes?: number;
  },
) {
  let createCount = 0;
  let promptCount = 0;
  let deleteCallCount = 0;
  const failTimes = deleteBehavior?.failTimes ?? 0;

  mockV2Session = {
    abort: mock(async () => ({ data: true })),
    create: mock(async () => ({ data: { id: `session-${createCount++}` } })),
    prompt: mock(async () => {
      const step = steps[promptCount++] ?? {};
      if (step.error) {
        throw step.error;
      }
      return {
        data: {
          parts: [{ type: 'text', text: step.text ?? '' }],
        },
      };
    }),
    delete: mock(async () => {
      deleteCallCount++;
      if (deleteCallCount <= failTimes) {
        throw new Error('delete failed');
      }
      return { data: true };
    }),
  };
  mockV2Tool = {
    ids: mock(async () => ({ data: ['read', 'bash'] })),
  };

  return {
    session: mockV2Session,
    tool: mockV2Tool,
  };
}

describe('smartfetch/secondary-model', () => {
  const models: SecondaryModel[] = [
    { providerID: 'provider-a', modelID: 'small' },
    { providerID: 'provider-b', modelID: 'fallback' },
  ];

  const testInput = { directory: '/tmp/project' } as never;

  afterEach(() => {
    mock.restore();
  });

  test('falls back when the first model returns empty text', async () => {
    mockV2Client = createV2ClientMock([
      { text: '   ' },
      { text: 'Useful answer' },
    ]);

    const result = await runSecondaryModelWithFallback(
      testInput,
      models,
      'Summarize the page',
      'This is enough fetched content to clear the short-content guard.',
    );

    expect(result.text).toBe('Useful answer');
    expect(result.model).toEqual(models[1]);
    expect(mockV2Session.prompt).toHaveBeenCalledTimes(2);
    expect(mockV2Session.delete).toHaveBeenCalledTimes(2);
  });

  test('falls back when the first model throws', async () => {
    mockV2Client = createV2ClientMock([
      { error: new Error('primary failed') },
      { text: 'Recovered answer' },
    ]);

    const result = await runSecondaryModelWithFallback(
      testInput,
      models,
      'Extract the answer',
      'This is enough fetched content to clear the short-content guard.',
    );

    expect(result.text).toBe('Recovered answer');
    expect(result.model).toEqual(models[1]);
    expect(mockV2Session.prompt).toHaveBeenCalledTimes(2);
    expect(mockV2Session.delete).toHaveBeenCalledTimes(2);
  });

  test('retries session delete on transient failure', async () => {
    const originalWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnCalls.push(args);
    const originalDelay = _testConfig.deleteRetryDelayMs;
    _testConfig.deleteRetryDelayMs = 0;
    try {
      mockV2Client = createV2ClientMock([{ text: 'Answer' }], { failTimes: 1 });

      const result = await runSecondaryModelWithFallback(
        testInput,
        [models[0]],
        'Summarize',
        'This is enough fetched content to clear the short-content guard.',
      );

      expect(result.text).toBe('Answer');
      // First attempt failed, second succeeded → 2 calls for one session
      expect(mockV2Session.delete).toHaveBeenCalledTimes(2);
      expect(warnCalls.length).toBe(0);
    } finally {
      console.warn = originalWarn;
      _testConfig.deleteRetryDelayMs = originalDelay;
    }
  });

  test('logs warning when all delete retries fail but does not throw', async () => {
    const originalWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnCalls.push(args);
    const originalDelay = _testConfig.deleteRetryDelayMs;
    _testConfig.deleteRetryDelayMs = 0;
    try {
      mockV2Client = createV2ClientMock([{ text: 'Answer' }], {
        failTimes: 99,
      });

      const result = await runSecondaryModelWithFallback(
        testInput,
        [models[0]],
        'Summarize',
        'This is enough fetched content to clear the short-content guard.',
      );

      // Secondary model still succeeds despite cleanup failure
      expect(result.text).toBe('Answer');
      expect(warnCalls.length).toBe(1);
      expect(String(warnCalls[0][0])).toContain('smartfetch');
    } finally {
      console.warn = originalWarn;
      _testConfig.deleteRetryDelayMs = originalDelay;
    }
  });

  test('falls back to next model when prompt times out', async () => {
    mockV2Session = {
      abort: mock(async () => ({ data: true })),
      create: mock(async () => ({ data: { id: 'session-timeout' } })),
      prompt: mock(async (opts: unknown) => {
        const model = (opts as { body?: { model?: { modelID?: string } } })
          ?.body?.model;
        if (model?.modelID === 'small') {
          throw new Error('Secondary model timed out');
        }
        return {
          data: {
            parts: [{ type: 'text', text: 'Fallback answer' }],
          },
        };
      }),
      delete: mock(async () => ({ data: true })),
    };
    mockV2Tool = {
      ids: mock(async () => ({ data: ['read'] })),
    };
    mockV2Client = {
      session: mockV2Session,
      tool: mockV2Tool,
    };

    const result = await runSecondaryModelWithFallback(
      testInput,
      models,
      'Summarize',
      'This is enough fetched content to clear the short-content guard.',
    );

    expect(result.text).toBe('Fallback answer');
    expect(result.model).toEqual(models[1]);
  });

  test('waits for a timed-out prompt to settle before deleting its session', async () => {
    const originalTimeout = _testConfig.secondaryModelTimeoutMs;
    _testConfig.secondaryModelTimeoutMs = 0;

    let resolvePrompt!: (value: {
      data: { parts: Array<{ type: string; text: string }> };
    }) => void;
    const promptResult = new Promise<{
      data: { parts: Array<{ type: string; text: string }> };
    }>((resolve) => {
      resolvePrompt = resolve;
    });
    let resolveDelete!: () => void;
    const deleted = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });

    mockV2Session = {
      abort: mock(async () => ({ data: true })),
      create: mock(async () => ({ data: { id: 'session-timeout' } })),
      prompt: mock(() => promptResult),
      delete: mock(async () => {
        resolveDelete();
        return { data: true };
      }),
    };
    mockV2Tool = {
      ids: mock(async () => ({ data: ['read'] })),
    };
    mockV2Client = {
      session: mockV2Session,
      tool: mockV2Tool,
    };

    const settledResult = {
      data: { parts: [{ type: 'text', text: 'Late answer' }] },
    };
    try {
      await expect(
        runSecondaryModelWithFallback(
          testInput,
          [models[0]],
          'Summarize',
          'This is enough fetched content to clear the short-content guard.',
        ),
      ).rejects.toThrow('Secondary model timed out');

      expect(mockV2Session.abort).toHaveBeenCalledTimes(1);
      expect(mockV2Session.delete).toHaveBeenCalledTimes(0);

      resolvePrompt(settledResult);
      await deleted;
      expect(mockV2Session.delete).toHaveBeenCalledTimes(1);
    } finally {
      resolvePrompt(settledResult);
      _testConfig.secondaryModelTimeoutMs = originalTimeout;
    }
  });

  test('does not create another session while timed-out cleanup is pending', async () => {
    const originalTimeout = _testConfig.secondaryModelTimeoutMs;
    _testConfig.secondaryModelTimeoutMs = 0;

    let resolvePrompt!: (value: {
      data: { parts: Array<{ type: string; text: string }> };
    }) => void;
    const pendingPrompt = new Promise<{
      data: { parts: Array<{ type: string; text: string }> };
    }>((resolve) => {
      resolvePrompt = resolve;
    });
    let promptCalls = 0;
    let createCalls = 0;
    let resolveDelete!: () => void;
    const deleted = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });

    mockV2Session = {
      abort: mock(async () => {
        throw new Error('abort failed');
      }),
      create: mock(async () => ({
        data: { id: `session-${createCalls++}` },
      })),
      prompt: mock(() => {
        promptCalls++;
        if (promptCalls === 1) return pendingPrompt;
        return Promise.resolve({
          data: { parts: [{ type: 'text', text: 'Recovered answer' }] },
        });
      }),
      delete: mock(async () => {
        setTimeout(resolveDelete, 0);
        return { data: true };
      }),
    };
    mockV2Tool = {
      ids: mock(async () => ({ data: ['read'] })),
    };
    mockV2Client = {
      session: mockV2Session,
      tool: mockV2Tool,
    };

    const settledResult = {
      data: { parts: [{ type: 'text', text: 'Late answer' }] },
    };
    try {
      await expect(
        runSecondaryModelWithFallback(
          testInput,
          [models[0]],
          'Summarize',
          'This is enough fetched content to clear the short-content guard.',
        ),
      ).rejects.toThrow('Secondary model timed out');

      expect(mockV2Session.create).toHaveBeenCalledTimes(1);
      expect(mockV2Session.prompt).toHaveBeenCalledTimes(1);
      expect(mockV2Session.delete).toHaveBeenCalledTimes(0);

      await expect(
        runSecondaryModelWithFallback(
          testInput,
          [models[0]],
          'Summarize again',
          'This is enough fetched content to clear the short-content guard.',
        ),
      ).rejects.toThrow('cleanup is still pending');

      expect(mockV2Session.create).toHaveBeenCalledTimes(1);
      expect(mockV2Session.prompt).toHaveBeenCalledTimes(1);
      expect(mockV2Session.delete).toHaveBeenCalledTimes(0);

      resolvePrompt(settledResult);
      await deleted;
      expect(mockV2Session.delete).toHaveBeenCalledTimes(1);

      const recovered = await runSecondaryModelWithFallback(
        testInput,
        [models[0]],
        'Summarize after cleanup',
        'This is enough fetched content to clear the short-content guard.',
      );
      expect(recovered.text).toBe('Recovered answer');
      expect(mockV2Session.create).toHaveBeenCalledTimes(2);
      expect(mockV2Session.prompt).toHaveBeenCalledTimes(2);
      expect(mockV2Session.delete).toHaveBeenCalledTimes(2);
    } finally {
      resolvePrompt(settledResult);
      _testConfig.secondaryModelTimeoutMs = originalTimeout;
    }
  });

  test('passes parentID to session.create when parentSessionID is provided', async () => {
    mockV2Client = createV2ClientMock([{ text: 'Answer' }]);

    const result = await runSecondaryModelWithFallback(
      testInput,
      [models[0]],
      'Summarize',
      'This is enough fetched content to clear the short-content guard.',
      'parent-session-id',
    );

    expect(result.text).toBe('Answer');
    expect(mockV2Session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          title: 'smartfetch-secondary',
          parentID: 'parent-session-id',
        }),
      }),
    );
  });

  test('omits parentID from session.create when parentSessionID is undefined', async () => {
    mockV2Client = createV2ClientMock([{ text: 'Answer' }]);

    const result = await runSecondaryModelWithFallback(
      testInput,
      [models[0]],
      'Summarize',
      'This is enough fetched content to clear the short-content guard.',
    );

    expect(result.text).toBe('Answer');
    expect(mockV2Session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { title: 'smartfetch-secondary' },
      }),
    );
  });
});
