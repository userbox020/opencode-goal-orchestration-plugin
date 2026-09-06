import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TmuxPaneRegistration {
  version: 1;
  sessionId: string;
  paneId: string;
  ownerPid: number;
  updatedAt: number;
}

export const TMUX_PANE_REGISTRATION_TTL_MS = 30_000;

function dataDir(): string {
  return (
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share')
  );
}

function sessionScope(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
}

export function getTmuxPaneRegistrationPath(sessionId: string): string {
  return path.join(
    dataDir(),
    'opencode',
    'storage',
    'oh-my-opencode-slim',
    'tmux-panes',
    `${sessionScope(sessionId)}.json`,
  );
}

function isPaneId(value: unknown): value is string {
  return typeof value === 'string' && /^%\d+$/.test(value);
}

export function recordTmuxPane(
  sessionId: string,
  paneId: string,
  ownerPid = process.pid,
): boolean {
  if (!sessionId || !isPaneId(paneId)) return false;

  const registration: TmuxPaneRegistration = {
    version: 1,
    sessionId,
    paneId,
    ownerPid,
    updatedAt: Date.now(),
  };

  try {
    const filePath = getTmuxPaneRegistrationPath(sessionId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, `${JSON.stringify(registration)}\n`);
      fs.renameSync(tmpPath, filePath);
      return true;
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // Best-effort state cleanup.
      }
    }
  } catch {
    return false;
  }
}

export function readTmuxPane(
  sessionId: string,
  now = Date.now(),
): string | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(getTmuxPaneRegistrationPath(sessionId), 'utf8'),
    ) as Partial<TmuxPaneRegistration>;
    if (
      parsed.version !== 1 ||
      parsed.sessionId !== sessionId ||
      !isPaneId(parsed.paneId) ||
      typeof parsed.updatedAt !== 'number' ||
      now - parsed.updatedAt > TMUX_PANE_REGISTRATION_TTL_MS
    ) {
      return undefined;
    }
    return parsed.paneId;
  } catch {
    return undefined;
  }
}

export function removeTmuxPane(
  sessionId: string,
  paneId: string,
  ownerPid = process.pid,
): void {
  try {
    const filePath = getTmuxPaneRegistrationPath(sessionId);
    const parsed = JSON.parse(
      fs.readFileSync(filePath, 'utf8'),
    ) as Partial<TmuxPaneRegistration>;
    if (parsed.paneId === paneId && parsed.ownerPid === ownerPid) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Registration may already be gone or replaced by another TUI.
  }
}
