import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getTmuxPaneRegistrationPath,
  readTmuxPane,
  recordTmuxPane,
  removeTmuxPane,
  TMUX_PANE_REGISTRATION_TTL_MS,
} from './tmux-pane-registry';

describe('tmux pane registry', () => {
  const originalXdgDataHome = process.env.XDG_DATA_HOME;
  let stateDirectory: string;

  beforeEach(() => {
    stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tmux-state-'));
    process.env.XDG_DATA_HOME = stateDirectory;
  });

  afterEach(() => {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    }
  });

  test('resolves a fresh pane registration for one session', () => {
    expect(recordTmuxPane('root-a', '%42', 100)).toBe(true);

    expect(readTmuxPane('root-a')).toBe('%42');
    expect(readTmuxPane('root-b')).toBeUndefined();
  });

  test('ignores expired registrations', () => {
    recordTmuxPane('root', '%42', 100);
    const filePath = getTmuxPaneRegistrationPath('root');
    const registration = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    expect(
      readTmuxPane(
        'root',
        registration.updatedAt + TMUX_PANE_REGISTRATION_TTL_MS + 1,
      ),
    ).toBeUndefined();
  });

  test('only removes a registration still owned by the disposing TUI', () => {
    recordTmuxPane('root', '%42', 100);
    removeTmuxPane('root', '%42', 200);
    expect(readTmuxPane('root')).toBe('%42');

    removeTmuxPane('root', '%42', 100);
    expect(readTmuxPane('root')).toBeUndefined();
  });

  test('rejects invalid tmux pane identifiers', () => {
    expect(recordTmuxPane('root', '../pane', 100)).toBe(false);
    expect(readTmuxPane('root')).toBeUndefined();
  });
});
