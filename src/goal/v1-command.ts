import { registerCommandHook } from '../hooks/command-hook-utils';
import { createInternalAgentTextPart } from '../utils';
import type { GoalCommands } from './core';

const COMMAND_NAME = 'goal';

export function createGoalCommandHook(options: {
  commandsForSession: (sessionID: string) => Promise<GoalCommands>;
  openPanel?: (input: {
    sessionID: string;
    readSnapshot: GoalCommands['readSnapshot'];
  }) => Promise<unknown>;
  notifyPanel?: (sessionID: string) => Promise<void>;
}) {
  let ownsCommand = false;
  return {
    registerCommand(config: Record<string, unknown>): void {
      ownsCommand = registerCommandHook(
        config,
        COMMAND_NAME,
        'Create and manage the current orchestration goal.',
        'Usage: /goal <objective> | status | panel | pause | resume | revise <objective> | clear',
      );
    },

    async handleCommandExecuteBefore(
      input: { command: string; sessionID: string; arguments: string },
      output: { parts: Array<{ type: string; text?: string }> },
    ): Promise<void> {
      if (input.command !== COMMAND_NAME) return;
      if (!ownsCommand) return;
      output.parts.length = 0;

      try {
        const argumentsText = input.arguments.trim();
        const [verb, ...rest] = argumentsText.split(/\s+/);
        if (verb === 'panel' && argumentsText !== 'panel') {
          output.parts.push(
            createInternalAgentTextPart(
              'Goal command rejected: /goal panel does not accept arguments.',
            ),
          );
          return;
        }

        const commands = await options.commandsForSession(input.sessionID);
        if (argumentsText === 'panel') {
          if (!options.openPanel) {
            throw new Error('Goal panel is unavailable');
          }
          await options.openPanel({
            sessionID: input.sessionID,
            readSnapshot: commands.readSnapshot,
          });
          if (options.notifyPanel) {
            try {
              await options.notifyPanel(input.sessionID);
            } catch {
              // The browser-open result remains usable if notification fails.
            }
          }
          output.parts.push(
            createInternalAgentTextPart('Goal panel opened in your browser.'),
          );
          return;
        }

        const objective = rest.join(' ').trim();
        if (!verb || verb === 'status') {
          output.parts.push(
            createInternalAgentTextPart(commands.renderGoalContext().context),
          );
          return;
        }
        if (verb === 'pause') {
          await commands.pause();
        } else if (verb === 'resume') {
          await commands.resume();
        } else if (verb === 'clear') {
          await commands.clear();
        } else if (verb === 'revise') {
          await commands.revise({
            objective,
            requiredCriteria: ['The revised objective is completed.'],
          });
        } else {
          const goalObjective = input.arguments.trim();
          await commands.create({
            objective: goalObjective,
            requiredCriteria: ['The requested objective is completed.'],
          });
        }
        output.parts.push(
          createInternalAgentTextPart(commands.renderGoalContext().context),
        );
      } catch (error) {
        const panelCommand = input.arguments.trim() === 'panel';
        output.parts.push(
          createInternalAgentTextPart(
            panelCommand
              ? 'Goal panel could not be opened. Rerun /goal panel.'
              : `Goal command rejected: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    },
  };
}
