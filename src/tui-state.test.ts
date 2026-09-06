import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getTuiStatePath,
  readTuiSnapshot,
  recordTuiAgentModel,
  recordTuiAgentModels,
} from './tui-state';

let previousXdgDataHome: string | undefined;
let tempDir: string;

beforeEach(() => {
  previousXdgDataHome = process.env.XDG_DATA_HOME;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-state-'));
  process.env.XDG_DATA_HOME = tempDir;
});

afterEach(() => {
  if (previousXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = previousXdgDataHome;
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('tui-state persistence', () => {
  test('persists enabled agent models', () => {
    recordTuiAgentModels(
      {
        agentModels: {
          explorer: 'openai/gpt-5.6-luna',
          fixer: 'openai/gpt-5.6-luna',
        },
        agentVariants: {
          explorer: 'low',
          fixer: 'high',
        },
      },
      tempDir,
    );

    const snapshot = readTuiSnapshot(tempDir);

    expect(snapshot.agentModels).toEqual({
      explorer: 'openai/gpt-5.6-luna',
      fixer: 'openai/gpt-5.6-luna',
    });
    expect(snapshot.agentVariants).toEqual({
      explorer: 'low',
      fixer: 'high',
    });
  });

  test('updates a single live agent model without dropping others', () => {
    recordTuiAgentModels(
      {
        agentModels: {
          orchestrator: 'default',
          explorer: 'openai/gpt-5.6-luna',
        },
      },
      tempDir,
    );

    recordTuiAgentModel(
      {
        agentName: 'orchestrator',
        model: 'openai/gpt-5.6',
      },
      tempDir,
    );

    expect(readTuiSnapshot(tempDir).agentModels).toEqual({
      orchestrator: 'openai/gpt-5.6',
      explorer: 'openai/gpt-5.6-luna',
    });
  });

  test('updates a single live agent variant without dropping others', () => {
    recordTuiAgentModels(
      {
        agentModels: {
          orchestrator: 'default',
          explorer: 'openai/gpt-5.6-luna',
        },
        agentVariants: {
          explorer: 'low',
        },
      },
      tempDir,
    );

    recordTuiAgentModel(
      {
        agentName: 'orchestrator',
        model: 'openai/gpt-5.6',
        variant: 'high',
      },
      tempDir,
    );

    expect(readTuiSnapshot(tempDir).agentVariants).toEqual({
      orchestrator: 'high',
      explorer: 'low',
    });
  });

  test('ignores legacy config status fields in old snapshots', () => {
    const filePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        agentModels: { explorer: 'openai/gpt-5.6-luna' },
        configInvalid: true,
        configInvalidByProject: { old: true },
      }),
    );

    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.agentModels).toEqual({
      explorer: 'openai/gpt-5.6-luna',
    });
    expect(snapshot.agentVariants).toEqual({});
  });

  test('cross-project isolation — different directories write independent state files', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-b-'));
    try {
      recordTuiAgentModels({ agentModels: { explorer: 'model-a' } }, dirA);
      recordTuiAgentModels({ agentModels: { explorer: 'model-b' } }, dirB);

      expect(readTuiSnapshot(dirA).agentModels.explorer).toBe('model-a');
      expect(readTuiSnapshot(dirB).agentModels.explorer).toBe('model-b');
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  test('skips the disk write when the recorded value is unchanged', () => {
    recordTuiAgentModel(
      { agentName: 'explorer', model: 'openai/gpt-5.6-luna' },
      tempDir,
    );

    const filePath = getTuiStatePath(tempDir);
    const oldMtime = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(filePath, oldMtime, oldMtime);
    const baselineMtime = fs.statSync(filePath).mtimeMs;

    // Same agent, same model: nothing changed, so the file must not be
    // rewritten (a write would bump the mtime from 2000 back to "now").
    recordTuiAgentModel(
      { agentName: 'explorer', model: 'openai/gpt-5.6-luna' },
      tempDir,
    );

    expect(fs.statSync(filePath).mtimeMs).toBe(baselineMtime);
  });

  test('keeps the final file intact when the atomic rename fails', async () => {
    recordTuiAgentModel(
      { agentName: 'explorer', model: 'openai/gpt-5.6-luna' },
      tempDir,
    );

    const fsModule = await import('node:fs');
    const renameSpy = spyOn(fsModule, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed');
    });

    try {
      recordTuiAgentModel(
        { agentName: 'explorer', model: 'openai/gpt-5.6' },
        tempDir,
      );
    } finally {
      renameSpy.mockRestore();
    }

    // The previously written state must still be readable in full.
    expect(readTuiSnapshot(tempDir).agentModels).toEqual({
      explorer: 'openai/gpt-5.6-luna',
    });

    const stateDir = path.dirname(getTuiStatePath(tempDir));
    expect(
      fs.readdirSync(stateDir).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  test('leaves no temp files behind on the happy path', () => {
    recordTuiAgentModel(
      { agentName: 'explorer', model: 'openai/gpt-5.6-luna' },
      tempDir,
    );

    const stateDir = path.dirname(getTuiStatePath(tempDir));
    expect(
      fs.readdirSync(stateDir).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });
});
