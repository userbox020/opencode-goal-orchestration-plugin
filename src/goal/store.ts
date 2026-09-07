import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  GOAL_STATE_VERSION,
  type GoalSessionState,
  goalSessionStateSchema,
} from './schema';

const writeQueues = new Map<string, Promise<void>>();
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 20;

export class GoalStateCorruptError extends Error {
  constructor(
    readonly statePath: string,
    cause: unknown,
  ) {
    super(`Goal state is corrupt: ${statePath}`, { cause });
    this.name = 'GoalStateCorruptError';
  }
}

export class GoalStateVersionConflictError extends Error {
  constructor() {
    super('Goal state changed before this update could be applied');
    this.name = 'GoalStateVersionConflictError';
  }
}

export class GoalStateLockError extends Error {
  constructor(
    readonly statePath: string,
    readonly reason: 'malformed' | 'ownership-lost' | 'timeout',
  ) {
    super(`Goal state lock ${reason}: ${statePath}`);
    this.name = 'GoalStateLockError';
  }
}

/** A CAS token ties an update to one durable goal incarnation. */
export interface GoalVersionCheck {
  goalID: string;
  sessionGeneration: number;
  recordVersion: number;
  epoch: number;
}

export interface GoalStoreOptions {
  /** The OpenCode data directory. This is intended for isolated tests. */
  root?: string;
  /** Alias for root when callers name the data-root explicitly. */
  dataRoot?: string;
  /** Retire known legacy state during reads. Disable for read-only snapshots. */
  migrateLegacyOnRead?: boolean;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  signal?: AbortSignal;
}

interface GoalLockMetadata {
  pid: number;
  acquiredAt: number;
  token: string;
}

export function getOpenCodeDataDir(): string {
  const configured = process.env.XDG_DATA_HOME?.trim();
  const dataHome =
    configured && isAbsolute(configured)
      ? configured
      : join(homedir(), '.local', 'share');
  return join(dataHome, 'opencode');
}

function emptyState(): GoalSessionState {
  return {
    version: GOAL_STATE_VERSION,
    sessionGeneration: 0,
    boardRunID: null,
    boardRunGeneration: 0,
    retiredBoardRunIDs: [],
    goal: null,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function supportsLiveProcess(pid: number): boolean | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error &&
      'code' in error &&
      (error.code === 'ESRCH' || error.code === 'ENOENT')
    ) {
      return false;
    }
    if (
      typeof error === 'object' &&
      error &&
      'name' in error &&
      error.name === 'SystemError' &&
      'errno' in error &&
      error.errno === 0
    ) {
      return false;
    }
    return undefined;
  }
}

function isUnsupportedFsyncError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'EINVAL' ||
      error.code === 'ENOTSUP' ||
      error.code === 'EOPNOTSUPP' ||
      error.code === 'EPERM')
  );
}

function parseLockMetadata(content: string): GoalLockMetadata | undefined {
  try {
    const value: unknown = JSON.parse(content);
    const record = value as Record<string, unknown> | null;
    if (
      !record ||
      typeof record !== 'object' ||
      !Number.isSafeInteger(record.pid) ||
      (record.pid as number) < 0 ||
      typeof record.acquiredAt !== 'number' ||
      !Number.isFinite(record.acquiredAt) ||
      typeof record.token !== 'string' ||
      !record.token.trim()
    ) {
      return undefined;
    }
    return record as unknown as GoalLockMetadata;
  } catch {
    return undefined;
  }
}

/** Durable, session-scoped storage with queue, lock, and CAS serialization. */
export class GoalStore {
  readonly statePath: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly migrateLegacyOnRead: boolean;
  private readonly signal?: AbortSignal;

  constructor(
    readonly sessionID: string,
    options: GoalStoreOptions = {},
  ) {
    if (!sessionID.trim()) {
      throw new Error('Goal session ID must be non-empty');
    }

    const root = options.root ?? options.dataRoot ?? getOpenCodeDataDir();
    const sessionFile = Buffer.from(sessionID).toString('base64url');
    this.statePath = join(
      root,
      'oh-my-opencode-slim',
      'goals',
      `${sessionFile}.json`,
    );
    this.lockPath = `${this.statePath}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? STALE_LOCK_MS;
    this.migrateLegacyOnRead = options.migrateLegacyOnRead ?? true;
    this.signal = options.signal;
  }

  read(): GoalSessionState {
    this.signal?.throwIfAborted();
    return this.readState();
  }

  private readState(ownerToken?: string): GoalSessionState {
    if (!existsSync(this.statePath)) return emptyState();

    try {
      const content = readFileSync(this.statePath, 'utf8');
      const parsed: unknown = JSON.parse(content);
      if (
        parsed &&
        typeof parsed === 'object' &&
        'version' in parsed &&
        typeof parsed.version === 'number' &&
        Number.isInteger(parsed.version) &&
        parsed.version > 0 &&
        parsed.version < GOAL_STATE_VERSION
      ) {
        if (!this.migrateLegacyOnRead) {
          throw new Error(
            `Legacy Goal state version ${parsed.version} requires migration`,
          );
        }
        if (ownerToken) {
          this.retireLegacyState(parsed.version, content, ownerToken);
          return emptyState();
        }
        const migrationOwner = this.acquireLockBlocking();
        try {
          return this.readState(migrationOwner);
        } finally {
          this.releaseLock(migrationOwner);
        }
      }
      return clone(goalSessionStateSchema.parse(parsed));
    } catch (error) {
      throw new GoalStateCorruptError(this.statePath, error);
    }
  }

  /**
   * Known prior formats are intentionally not interpreted as V4 evidence.
   * Preserve their bytes first, then atomically install an empty V4 state.
   */
  private retireLegacyState(
    version: number,
    legacyContent: string,
    ownerToken: string,
  ): void {
    this.assertLockOwnership(ownerToken);
    const backupPath = `${this.statePath}.v${version}.backup`;
    if (existsSync(backupPath)) {
      if (readFileSync(backupPath, 'utf8') !== legacyContent) {
        throw new GoalStateCorruptError(
          this.statePath,
          new Error(`Legacy backup conflicts with state: ${backupPath}`),
        );
      }
    } else {
      const backupTemporaryPath = `${backupPath}.${crypto.randomUUID()}.tmp`;
      const descriptor = openSync(backupTemporaryPath, 'wx', 0o600);
      try {
        writeFileSync(descriptor, legacyContent, 'utf8');
        this.fsync(descriptor);
        closeSync(descriptor);
        renameSync(backupTemporaryPath, backupPath);
        this.fsyncDirectory(dirname(this.statePath));
      } finally {
        try {
          closeSync(descriptor);
        } catch {
          // The descriptor was already closed after syncing.
        }
        rmSync(backupTemporaryPath, { force: true });
      }
    }
    this.write(emptyState(), ownerToken);
  }

  async update(
    expected: GoalVersionCheck | undefined,
    update: (state: GoalSessionState) => void,
  ): Promise<GoalSessionState> {
    let releaseQueue!: () => void;
    const previous = writeQueues.get(this.statePath) ?? Promise.resolve();
    const queued = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const queue = previous.then(() => queued);
    writeQueues.set(this.statePath, queue);

    await previous;
    try {
      this.signal?.throwIfAborted();
      const ownerToken = await this.acquireLock();
      try {
        this.signal?.throwIfAborted();
        this.assertLockOwnership(ownerToken);
        const state = this.readState(ownerToken);
        this.assertExpectedVersion(state, expected);
        const before = JSON.stringify(state);
        update(state);
        const parsedState = goalSessionStateSchema.parse(state);
        if (JSON.stringify(parsedState) !== before)
          this.write(parsedState, ownerToken);
        return clone(parsedState);
      } finally {
        this.releaseLock(ownerToken);
      }
    } finally {
      releaseQueue();
      if (writeQueues.get(this.statePath) === queue) {
        writeQueues.delete(this.statePath);
      }
    }
  }

  private assertExpectedVersion(
    state: GoalSessionState,
    expected: GoalVersionCheck | undefined,
  ): void {
    if (!expected) return;
    const goal = state.goal;
    if (
      !goal ||
      goal.id !== expected.goalID ||
      state.sessionGeneration !== expected.sessionGeneration ||
      goal.recordVersion !== expected.recordVersion ||
      goal.epoch !== expected.epoch
    ) {
      throw new GoalStateVersionConflictError();
    }
  }

  private async acquireLock(): Promise<string> {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        const ownerToken = this.publishLock(this.lockPath);
        this.assertLockOwnership(ownerToken);
        return ownerToken;
      } catch (error) {
        if (!this.isExistingLockError(error, this.lockPath)) throw error;
        this.recoverStaleLock();
        if (Date.now() >= deadline) {
          throw new GoalStateLockError(this.statePath, 'timeout');
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
  }

  private acquireLockBlocking(): string {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        const ownerToken = this.publishLock(this.lockPath);
        this.assertLockOwnership(ownerToken);
        return ownerToken;
      } catch (error) {
        if (!this.isExistingLockError(error, this.lockPath)) throw error;
        this.recoverStaleLock();
        if (Date.now() >= deadline) {
          throw new GoalStateLockError(this.statePath, 'timeout');
        }
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          LOCK_RETRY_MS,
        );
      }
    }
  }

  private publishLock(path: string): string {
    const token = crypto.randomUUID();
    const temporaryPath = `${path}.pending.${process.pid}.${token}`;
    const descriptor = openSync(temporaryPath, 'wx', 0o600);
    try {
      writeFileSync(
        descriptor,
        JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), token }),
        'utf8',
      );
      this.fsync(descriptor);
      closeSync(descriptor);
      // Hard-link publication is atomic and never replaces an existing lock.
      linkSync(temporaryPath, path);
      this.fsyncDirectory(dirname(path));
      return token;
    } finally {
      try {
        closeSync(descriptor);
      } catch {
        // The descriptor was already closed after syncing.
      }
      rmSync(temporaryPath, { force: true });
    }
  }

  private isExistingLockError(error: unknown, path: string): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'EEXIST' ||
        error.code === 'ENOTEMPTY' ||
        (error.code === 'EPERM' && existsSync(path)))
    );
  }

  private recoverStaleLock(): void {
    const observed = this.readLockForRecovery();
    if (!observed || !this.isStaleLock(observed)) return;
    const recoveryToken = this.acquireRecoveryLock();
    if (!recoveryToken) return;
    try {
      const current = this.readLockForRecovery();
      if (
        !current ||
        current.metadata.token !== observed.metadata.token ||
        !this.isStaleLock(current)
      ) {
        return;
      }
      const stalePath = `${this.lockPath}.stale.${process.pid}.${crypto.randomUUID()}`;
      renameSync(this.lockPath, stalePath);
      rmSync(stalePath, { recursive: true, force: true });
    } catch (error) {
      if (error instanceof GoalStateLockError) throw error;
      // A competing owner/reclaimer changed the lock; retry bounded acquisition.
    } finally {
      this.releaseRecoveryLock(recoveryToken);
    }
  }

  private readLockForRecovery():
    | { stats: ReturnType<typeof statSync>; metadata: GoalLockMetadata }
    | undefined {
    return this.readLockAt(this.lockPath);
  }

  private readLockAt(
    path: string,
  ):
    | { stats: ReturnType<typeof statSync>; metadata: GoalLockMetadata }
    | undefined {
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(path);
    } catch {
      return undefined;
    }

    let content: string;
    try {
      content = readFileSync(
        stats.isDirectory() ? join(path, 'owner.json') : path,
        'utf8',
      );
    } catch {
      throw new GoalStateLockError(this.statePath, 'malformed');
    }
    const metadata = parseLockMetadata(content);
    if (!metadata) {
      throw new GoalStateLockError(this.statePath, 'malformed');
    }
    return { stats, metadata };
  }

  private isStaleLock(lock: {
    stats: ReturnType<typeof statSync>;
    metadata: GoalLockMetadata;
  }): boolean {
    const modifiedAt = Number(lock.stats?.mtimeMs);
    return (
      Number.isFinite(modifiedAt) &&
      Date.now() - modifiedAt >= this.staleLockMs &&
      Date.now() - lock.metadata.acquiredAt >= this.staleLockMs &&
      supportsLiveProcess(lock.metadata.pid) === false
    );
  }

  private acquireRecoveryLock(): string | undefined {
    const recoveryPath = this.recoveryLockPath();
    this.recoverStaleRecoveryLock(recoveryPath);
    try {
      return this.publishLock(recoveryPath);
    } catch (error) {
      if (this.isExistingLockError(error, recoveryPath)) return undefined;
      throw error;
    }
  }

  private recoverStaleRecoveryLock(recoveryPath: string): void {
    const observed = this.readLockAt(recoveryPath);
    if (!observed || !this.isStaleLock(observed)) return;
    try {
      const current = this.readLockAt(recoveryPath);
      if (
        !current ||
        current.metadata.token !== observed.metadata.token ||
        !this.isStaleLock(current)
      ) {
        return;
      }
      const stalePath = `${recoveryPath}.stale.${process.pid}.${crypto.randomUUID()}`;
      renameSync(recoveryPath, stalePath);
      rmSync(stalePath, { recursive: true, force: true });
    } catch (error) {
      if (error instanceof GoalStateLockError) throw error;
      // A competing reclaimer changed the recovery lock; retry acquisition.
    }
  }

  private releaseRecoveryLock(token: string): void {
    this.assertRecoveryOwnership(token);
    rmSync(this.recoveryLockPath(), { recursive: true });
  }

  private assertRecoveryOwnership(token: string): void {
    const recoveryPath = this.recoveryLockPath();
    const stats = statSync(recoveryPath);
    const metadata = parseLockMetadata(
      readFileSync(
        stats.isDirectory() ? join(recoveryPath, 'owner.json') : recoveryPath,
        'utf8',
      ),
    );
    if (!metadata || metadata.token !== token) {
      throw new GoalStateLockError(this.statePath, 'ownership-lost');
    }
  }

  private assertLockOwnership(ownerToken: string): void {
    let metadata: GoalLockMetadata | undefined;
    try {
      const stats = statSync(this.lockPath);
      metadata = stats.isDirectory()
        ? parseLockMetadata(readFileSync(this.lockMetadataPath(), 'utf8'))
        : parseLockMetadata(readFileSync(this.lockPath, 'utf8'));
    } catch {
      metadata = undefined;
    }
    if (!metadata || metadata.token !== ownerToken) {
      throw new GoalStateLockError(this.statePath, 'ownership-lost');
    }
  }

  private releaseLock(ownerToken: string): void {
    this.assertLockOwnership(ownerToken);
    rmSync(this.lockPath, { recursive: true });
  }

  private lockMetadataPath(): string {
    return join(this.lockPath, 'owner.json');
  }

  private recoveryLockPath(): string {
    return `${this.lockPath}.recovery`;
  }

  private write(state: GoalSessionState, ownerToken: string): void {
    this.assertLockOwnership(ownerToken);
    const directory = dirname(this.statePath);
    const temporaryPath = join(
      directory,
      `.${Buffer.from(this.sessionID).toString('base64url')}.` +
        `${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    const descriptor = openSync(temporaryPath, 'wx', 0o600);

    try {
      writeFileSync(descriptor, `${JSON.stringify(state)}\n`, 'utf8');
      this.fsync(descriptor);
      closeSync(descriptor);
      this.assertLockOwnership(ownerToken);
      renameSync(temporaryPath, this.statePath);
      this.fsyncDirectory(directory);
    } finally {
      try {
        closeSync(descriptor);
      } catch {
        // The descriptor was closed after syncing, or opening/writing failed.
      }
      rmSync(temporaryPath, { force: true });
    }
  }

  private fsync(descriptor: number): void {
    try {
      fsyncSync(descriptor);
    } catch (error) {
      if (isUnsupportedFsyncError(error)) return;
      throw error;
    }
  }

  private fsyncDirectory(directory: string): void {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(directory, 'r');
      this.fsync(descriptor);
    } catch (error) {
      if (!isUnsupportedFsyncError(error)) throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}

export function isGoalStateCorruptError(
  error: unknown,
): error is GoalStateCorruptError {
  return error instanceof GoalStateCorruptError;
}
