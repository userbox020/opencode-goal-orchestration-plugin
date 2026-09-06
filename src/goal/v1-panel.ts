import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import type { GoalSnapshot } from './core';
import { renderGoalPanelPage } from './v1-panel-ui';

export type GoalSnapshotReader = () => GoalSnapshot;

export interface OpenGoalPanelInput {
  sessionID: string;
  readSnapshot: GoalSnapshotReader;
}

export interface GoalPanelManagerOptions {
  openBrowser?: (url: string) => void | Promise<void>;
}

export interface GoalPanelManager {
  openPanel(input: OpenGoalPanelInput): Promise<string>;
  revokeSession(sessionID: string): void;
  confirmSession(sessionID: string): void;
  dispose(): Promise<void>;
}

interface Capability {
  sessionID: string;
  readSnapshot: GoalSnapshotReader;
}

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const command =
    platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Goal panel browser launcher timed out'));
    }, 5_000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Goal panel browser launcher unavailable'));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Goal panel browser launcher failed'));
    });
    child.unref();
  });
}

function securityHeaders(response: ServerResponse, nonce?: string): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (nonce) {
    response.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    );
  } else {
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  }
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  securityHeaders(response);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', JSON_CONTENT_TYPE);
  response.end(JSON.stringify(body));
}

function requestUrl(request: IncomingMessage): URL | undefined {
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1');
  } catch {
    return undefined;
  }
}

function bearerToken(request: IncomingMessage): string | undefined {
  if (request.headers.cookie) return undefined;
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const token = authorization.slice('Bearer '.length);
  return token && !/\s/.test(token) ? token : undefined;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

class GoalPanelManagerImpl implements GoalPanelManager {
  private readonly capabilities = new Map<string, Capability>();
  private readonly sessionTokens = new Map<string, Set<string>>();
  private readonly deletedSessions = new Set<string>();
  private readonly connections = new Set<Socket>();
  private readonly browserOpener: (url: string) => void | Promise<void>;
  private server: ReturnType<typeof createServer> | undefined;
  private startPromise: Promise<number> | undefined;
  private disposePromise: Promise<void> | undefined;
  private disposed = false;

  constructor(options: GoalPanelManagerOptions = {}) {
    this.browserOpener = options.openBrowser ?? openBrowser;
  }

  async openPanel(input: OpenGoalPanelInput): Promise<string> {
    if (this.disposed) throw new Error('Goal panel is unavailable');
    if (!input.sessionID.trim() || this.deletedSessions.has(input.sessionID)) {
      throw new Error('Goal panel is unavailable');
    }

    const port = await this.startServer();
    if (this.disposed || this.deletedSessions.has(input.sessionID)) {
      throw new Error('Goal panel is unavailable');
    }
    const token = randomBytes(32).toString('base64url');
    this.capabilities.set(token, {
      sessionID: input.sessionID,
      readSnapshot: input.readSnapshot,
    });
    const tokens = this.sessionTokens.get(input.sessionID) ?? new Set<string>();
    tokens.add(token);
    this.sessionTokens.set(input.sessionID, tokens);

    const url = `http://127.0.0.1:${port}/#${token}`;
    try {
      await this.browserOpener(url);
      if (
        this.disposed ||
        this.deletedSessions.has(input.sessionID) ||
        !this.capabilities.has(token)
      ) {
        throw new Error('Goal panel is unavailable');
      }
      for (const previous of tokens) {
        if (previous === token) continue;
        this.capabilities.delete(previous);
        tokens.delete(previous);
      }
    } catch {
      this.capabilities.delete(token);
      tokens.delete(token);
      throw new Error('Goal panel could not be opened');
    }
    return url;
  }

  revokeSession(sessionID: string): void {
    this.deletedSessions.add(sessionID);
    this.clearSessionCapabilities(sessionID);
  }

  private clearSessionCapabilities(sessionID: string): void {
    const tokens = this.sessionTokens.get(sessionID);
    if (!tokens) return;
    for (const token of tokens) this.capabilities.delete(token);
    this.sessionTokens.delete(sessionID);
  }

  confirmSession(sessionID: string): void {
    this.deletedSessions.delete(sessionID);
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.capabilities.clear();
    this.sessionTokens.clear();
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    const server = this.server;
    this.server = undefined;
    const startPromise = this.startPromise;
    this.disposePromise = (async () => {
      await startPromise?.catch(() => {});
      if (server) await closeServer(server);
    })();
    return this.disposePromise;
  }

  private async startServer(): Promise<number> {
    if (this.disposed) throw new Error('Goal panel is unavailable');
    if (this.server?.listening) {
      const address = this.server.address();
      if (address && typeof address !== 'string') return address.port;
    }
    if (this.startPromise) return this.startPromise;

    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    server.on('connection', (socket) => {
      this.connections.add(socket);
      socket.once('close', () => this.connections.delete(socket));
    });
    this.server = server;
    this.startPromise = new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Goal panel is unavailable'));
          return;
        }
        resolve(address.port);
      });
    });

    try {
      const port = await this.startPromise;
      if (this.disposed) {
        await closeServer(server);
        throw new Error('Goal panel is unavailable');
      }
      return port;
    } catch {
      if (this.server === server) {
        this.server = undefined;
        await closeServer(server);
      }
      throw new Error('Goal panel is unavailable');
    } finally {
      this.startPromise = undefined;
    }
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = requestUrl(request);
    if (!url || url.search || request.headers.cookie) {
      writeJson(response, 404, { error: 'not found' });
      return;
    }

    if (url.pathname === '/') {
      if (request.method !== 'GET') {
        writeJson(response, 404, { error: 'not found' });
        return;
      }
      const nonce = randomBytes(16).toString('base64url');
      securityHeaders(response, nonce);
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      try {
        response.end(renderGoalPanelPage(nonce));
      } catch {
        response.statusCode = 500;
        response.end('Goal panel unavailable');
      }
      return;
    }

    if (url.pathname !== '/api/v1/snapshot' || request.method !== 'GET') {
      writeJson(response, 404, { error: 'not found' });
      return;
    }

    const token = bearerToken(request);
    const capability = token ? this.capabilities.get(token) : undefined;
    if (!capability || this.disposed) {
      writeJson(response, 401, { error: 'unauthorized' });
      return;
    }

    try {
      writeJson(response, 200, capability.readSnapshot());
    } catch {
      writeJson(response, 500, { error: 'snapshot unavailable' });
    }
  }
}

export function createGoalPanelManager(
  options: GoalPanelManagerOptions = {},
): GoalPanelManager {
  return new GoalPanelManagerImpl(options);
}
