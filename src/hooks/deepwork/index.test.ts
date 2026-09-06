import { describe, expect, test } from 'bun:test';
import { SLIM_INTERNAL_INITIATOR_MARKER } from '../../utils';
import { createDeepworkCommandHook } from './index';

describe('deepwork command hook', () => {
  test('registers /deepwork command when absent', () => {
    const hook = createDeepworkCommandHook();
    const config: Record<string, unknown> = {};

    hook.registerCommand(config);

    const command = (config.command as Record<string, unknown>).deepwork as {
      template?: string;
      description?: string;
    };
    expect(command).toBeDefined();
    expect(command.template).toContain('deepwork');
    expect(command.description).toContain('heavy');
  });

  test('does not overwrite existing /deepwork command', () => {
    const hook = createDeepworkCommandHook();
    const existing = { template: 'custom', description: 'custom command' };
    const config: Record<string, unknown> = { command: { deepwork: existing } };

    hook.registerCommand(config);

    expect((config.command as Record<string, unknown>).deepwork).toBe(existing);
  });

  test('asks for a task when no arguments are provided', async () => {
    const hook = createDeepworkCommandHook();
    const output = { parts: [{ type: 'text', text: 'template' }] };

    await hook.handleCommandExecuteBefore(
      { command: 'deepwork', sessionID: 's1', arguments: '  ' },
      output,
    );

    expect(output.parts).toHaveLength(1);
    expect(output.parts[0].text).toContain('What task should deepwork manage?');
    expect(output.parts[0].text).toContain(SLIM_INTERNAL_INITIATOR_MARKER);
  });

  test('expands arguments into a deepwork activation prompt', async () => {
    const hook = createDeepworkCommandHook();
    const output = { parts: [{ type: 'text', text: 'template' }] };

    await hook.handleCommandExecuteBefore(
      {
        command: 'deepwork',
        sessionID: 's1',
        arguments: 'refactor scheduler state',
      },
      output,
    );

    expect(output.parts).toHaveLength(1);
    expect(output.parts[0].text).toContain('Use the deepwork skill');
    expect(output.parts[0].text).toContain(
      'before planning, delegation, or creating state',
    );
    expect(output.parts[0].text).toContain('.gitignore');
    expect(output.parts[0].text).toContain('.ignore');
    expect(output.parts[0].text).toContain('!.slim/deepwork/');
    expect(output.parts[0].text).toContain('!.slim/deepwork/**');
    expect(output.parts[0].text).toContain(
      'add only missing entries without duplicates',
    );
    expect(output.parts[0].text).toContain('git-local yet OpenCode-readable');
    expect(output.parts[0].text).toContain('.slim/deepwork/');
    expect(output.parts[0].text).toContain('save code/doc deliverables');
    expect(output.parts[0].text).toContain('@oracle');
    expect(output.parts[0].text).toContain('simplify/readability');
    expect(output.parts[0].text).toContain('refactor scheduler state');
    expect(output.parts[0].text).not.toContain(SLIM_INTERNAL_INITIATOR_MARKER);
  });

  test('ignores other commands', async () => {
    const hook = createDeepworkCommandHook();
    const output = { parts: [{ type: 'text', text: 'template' }] };

    await hook.handleCommandExecuteBefore(
      { command: 'preset', sessionID: 's1', arguments: 'x' },
      output,
    );

    expect(output.parts).toEqual([{ type: 'text', text: 'template' }]);
  });
});
