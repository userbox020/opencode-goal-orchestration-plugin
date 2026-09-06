import type { InterviewConfig, PluginConfig } from '../config';
import { DEFAULT_DASHBOARD_PORT } from '../interview/dashboard';
import { createDashboardManager } from '../interview/dashboard-manager';
import type { InterviewSessionRuntime } from '../interview/runtime';
import { createInterviewServer } from '../interview/server';
import { createInterviewService } from '../interview/service';
import type { InterviewMessage } from '../interview/types';
import { log } from '../utils/logger';
import type { V2Context, V2SessionContextEvent } from './types';

export const INTERVIEW_COMMAND_MARKER =
  '<omos-interview-command>$ARGUMENTS</omos-interview-command>';

const MARKER_PATTERN =
  /<omos-interview-command>\s*([\s\S]*?)\s*<\/omos-interview-command>/i;

type V2SessionMethods = {
  prompt?: (input: Record<string, unknown>) => Promise<unknown>;
  promptAsync?: (input: Record<string, unknown>) => Promise<unknown>;
  synthetic?: (input: Record<string, unknown>) => Promise<unknown>;
  update?: (input: Record<string, unknown>) => Promise<unknown>;
};

function textFromContent(content: Array<Record<string, unknown>>): string {
  return content
    .filter((part) => part.type === 'text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function toInterviewMessages(event: V2SessionContextEvent): InterviewMessage[] {
  return event.messages.map((message) => ({
    info: { role: message.role, id: message.id },
    parts: message.content.map((part) => ({
      type: typeof part.type === 'string' ? part.type : undefined,
      text: typeof part.text === 'string' ? part.text : undefined,
    })),
  }));
}

export interface V2InterviewBridge {
  readonly service: ReturnType<typeof createInterviewService>;
  readonly runtime: InterviewSessionRuntime;
  registerCommand(draft: {
    update(
      name: string,
      update: (command: Record<string, unknown>) => void,
    ): void;
  }): void;
  handleContext(event: V2SessionContextEvent): Promise<void>;
  handleEvent(event: Record<string, unknown>): Promise<void>;
  getTranscript(sessionID: string): InterviewMessage[];
  dispose(): void;
}

export function createV2InterviewBridge(
  ctx: V2Context,
  config?: InterviewConfig,
): V2InterviewBridge {
  const transcripts = new Map<string, InterviewMessage[]>();
  const activeText = new Map<string, string>();
  const methods = ctx.session as V2SessionMethods;

  const runtime: InterviewSessionRuntime = {
    messages: async (sessionID) => transcripts.get(sessionID) ?? [],
    notify: async (sessionID, text) => {
      if (methods.synthetic) {
        await methods.synthetic({ sessionID, text });
        return;
      }
      if (methods.prompt) {
        await methods.prompt({
          sessionID,
          noReply: true,
          parts: [{ type: 'text', text }],
        });
      }
    },
    continue: async (sessionID, text) => {
      const input = {
        sessionID,
        agent: 'orchestrator',
        parts: [{ type: 'text', text, synthetic: true }],
      };
      if (methods.promptAsync) {
        await methods.promptAsync(input);
        return;
      }
      if (methods.prompt) await methods.prompt(input);
    },
    rename: async (sessionID, title) => {
      if (methods.update) await methods.update({ sessionID, title });
    },
  };

  const dashboardEnabled =
    config?.dashboard === true || (config?.port ?? 0) > 0;
  const outputFolder = config?.outputFolder ?? 'interview';
  const dashboardPort =
    (config?.port ?? 0) > 0 ? (config?.port ?? 0) : DEFAULT_DASHBOARD_PORT;
  const pluginContext = { directory: process.cwd() } as never;
  const dashboardManager = dashboardEnabled
    ? createDashboardManager(
        pluginContext,
        { interview: config } as PluginConfig,
        dashboardPort,
        outputFolder,
        {
          runtime,
          sessionClient: {
            list: async () => ({ data: [] }),
          } as never,
        },
      )
    : null;
  const service =
    dashboardManager?.service ??
    createInterviewService(pluginContext, config, { runtime });
  const server = dashboardManager
    ? null
    : createInterviewServer({
        getState: (interviewID) => service.getInterviewState(interviewID),
        listInterviewFiles: () => service.listInterviewFiles(),
        listInterviews: () => service.listInterviews(),
        submitAnswers: (interviewID, answers) =>
          service.submitAnswers(interviewID, answers),
        submitBlockComment: (interviewID, section, comment) =>
          service.submitBlockComment(interviewID, section, comment),
        submitChat: (interviewID, message) =>
          service.submitChat(interviewID, message),
        handleNudgeAction: (interviewID, action) =>
          service.handleNudgeAction(interviewID, action),
        outputFolder,
        port: 0,
      });
  if (server) service.setBaseUrlResolver(() => server.ensureStarted());

  function registerCommand(draft: {
    update(
      name: string,
      update: (command: Record<string, unknown>) => void,
    ): void;
  }): void {
    draft.update('interview', (command) => {
      command.name = 'interview';
      command.agent = 'orchestrator';
      command.description = 'Open a localhost interview UI for a feature idea';
      command.template = INTERVIEW_COMMAND_MARKER;
    });
  }

  async function handleContext(event: V2SessionContextEvent): Promise<void> {
    const messages = toInterviewMessages(event);
    transcripts.set(event.sessionID, messages);

    const trailing = event.messages.at(-1);
    if (trailing?.role !== 'user') return;
    const text = textFromContent(trailing.content);
    const match = text.match(MARKER_PATTERN);
    if (!match) return;

    const output = {
      parts: [] as Array<{
        type: string;
        text?: string;
        synthetic?: boolean;
        metadata?: Record<string, unknown>;
      }>,
    };
    await (dashboardManager ?? service).handleCommandExecuteBefore(
      {
        command: 'interview',
        sessionID: event.sessionID,
        arguments: match[1].trim(),
      },
      output,
    );

    // Only replace the current command message. Earlier messages are left
    // byte-for-byte untouched so provider prompt prefixes remain cacheable.
    trailing.content = output.parts.map((part) => ({ ...part }));
    transcripts.set(event.sessionID, toInterviewMessages(event));
  }

  function appendText(sessionID: string, text: string): void {
    const messages = transcripts.get(sessionID) ?? [];
    const last = messages.at(-1);
    if (last?.info?.role === 'assistant') {
      const part = last.parts?.find((item) => item.type === 'text');
      if (part) {
        part.text = text;
      } else {
        last.parts = [{ type: 'text', text }];
      }
    } else {
      messages.push({
        info: { role: 'assistant' },
        parts: [{ type: 'text', text }],
      });
    }
    transcripts.set(sessionID, messages);
  }

  function beginText(sessionID: string): void {
    const messages = transcripts.get(sessionID) ?? [];
    messages.push({
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: '' }],
    });
    transcripts.set(sessionID, messages);
  }

  async function handleEvent(event: Record<string, unknown>): Promise<void> {
    const type = typeof event.type === 'string' ? event.type : '';
    const properties = (event.properties ?? {}) as Record<string, unknown>;
    const sessionID =
      (typeof properties.sessionID === 'string' && properties.sessionID) ||
      ((properties.info as { id?: string } | undefined)?.id ?? '');
    if (!sessionID) return;

    if (type === 'session.next.text.started') {
      activeText.set(sessionID, '');
      beginText(sessionID);
      return;
    }
    if (type === 'session.next.text.delta') {
      const text = `${activeText.get(sessionID) ?? ''}${typeof properties.delta === 'string' ? properties.delta : ''}`;
      activeText.set(sessionID, text);
      appendText(sessionID, text);
      return;
    }
    if (type === 'session.next.text.ended') {
      const text =
        typeof properties.text === 'string'
          ? properties.text
          : (activeText.get(sessionID) ?? '');
      activeText.delete(sessionID);
      appendText(sessionID, text);
      await (dashboardManager ?? service).handleEvent({
        event: { type, properties },
      });
      return;
    }
    if (type === 'session.deleted') {
      activeText.delete(sessionID);
      transcripts.delete(sessionID);
      await (dashboardManager ?? service).handleEvent({
        event: { type: 'session.deleted', properties: { sessionID } },
      });
      return;
    }

    if (type === 'session.status') {
      await (dashboardManager ?? service).handleEvent({
        event: { type, properties },
      });
    }
  }

  return {
    service,
    runtime,
    registerCommand,
    handleContext,
    handleEvent,
    getTranscript: (sessionID) => transcripts.get(sessionID) ?? [],
    dispose: async () => {
      if (dashboardManager) await dashboardManager.dispose();
      server?.close();
      activeText.clear();
      transcripts.clear();
      log('[v2][interview] bridge disposed');
    },
  };
}
