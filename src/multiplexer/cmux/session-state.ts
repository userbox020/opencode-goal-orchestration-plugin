import type { PaneResult } from '../types';
import type { CmuxCloseIntent } from './close-policy';

export type CmuxSpawnState = 'known' | 'spawning' | 'attached' | 'failed';
export type CmuxLifecycleState = 'active' | 'deleted' | 'orphaned';

export interface CmuxDeferredSpawn {
  deadline: number;
  generation: number;
  timer?: { cancel(): void };
}

export interface CmuxSessionRecord {
  session: string;
  owner: string;
  /** Monotonic lifecycle owner fence used for late-pane takeover. */
  ownerGeneration?: number;
  parent: string;
  title: string;
  directory: string;
  /** Server scope that created the pane. */
  serverUrl?: string;
  paneId?: string;
  spawnState: CmuxSpawnState;
  lifecycle: CmuxLifecycleState;
  attachedAt?: number;
  lastActivityAt: number;
  activityVersion: number;
  idleConsecutive: number;
  statusMissingSince?: number;
  /** Set only by a coordinator terminal outcome, not by status absence. */
  terminalConfirmed?: boolean;
  deferredSpawn?: CmuxDeferredSpawn;
  closeIntent?: CmuxCloseIntent;
  closeTimer?: { cancel(): void };
  closePromise?: Promise<void>;
  /** Result of a close that settled after ownership changed. */
  closeSettlement?: CmuxCloseSettlement;
  spawnPromise?: Promise<PaneResult>;
  /** A pane returned by a spawn generation that can no longer be adopted. */
  latePaneCleanup?: boolean;
}

export interface CmuxCloseSettlement {
  paneId: string;
  closed: boolean;
}

const STORE_KEY = Symbol.for('oh-my-opencode-slim.cmux-session-store');
const OWNER_GENERATION_KEY = Symbol.for(
  'oh-my-opencode-slim.cmux-owner-generation',
);
const ORPHAN_OBSERVERS_KEY = Symbol.for(
  'oh-my-opencode-slim.cmux-orphan-observers',
);

interface LatePaneOrphanObserver {
  ownerGeneration: number;
  directory: string;
  serverUrl: string | (() => string | undefined);
  callback: (record: CmuxSessionRecord) => void;
}

function records(): Map<string, CmuxSessionRecord> {
  const globalStore = globalThis as typeof globalThis & {
    [STORE_KEY]?: Map<string, CmuxSessionRecord>;
  };
  globalStore[STORE_KEY] ??= new Map();
  return globalStore[STORE_KEY];
}

function orphanObservers(): Set<LatePaneOrphanObserver> {
  const globalStore = globalThis as typeof globalThis & {
    [ORPHAN_OBSERVERS_KEY]?: Set<LatePaneOrphanObserver>;
  };
  globalStore[ORPHAN_OBSERVERS_KEY] ??= new Set();
  return globalStore[ORPHAN_OBSERVERS_KEY];
}

function nextOwnerGeneration(): number {
  const globalStore = globalThis as typeof globalThis & {
    [OWNER_GENERATION_KEY]?: number;
  };
  const generation = (globalStore[OWNER_GENERATION_KEY] ?? 0) + 1;
  globalStore[OWNER_GENERATION_KEY] = generation;
  return generation;
}

export class CmuxSessionStore {
  registerOwner(): number {
    return nextOwnerGeneration();
  }

  consumeCloseSettlement(
    record: CmuxSessionRecord,
  ): CmuxCloseSettlement | undefined {
    if (records().get(record.session) !== record) return undefined;
    const settlement = record.closeSettlement;
    if (!settlement) return undefined;
    if (settlement.paneId !== record.paneId) {
      record.closeSettlement = undefined;
      return undefined;
    }
    record.closeSettlement = undefined;
    return settlement;
  }
  claimCreated(record: CmuxSessionRecord): boolean {
    const existing = records().get(record.session);
    if (existing) {
      if (
        existing.directory !== record.directory ||
        (existing.lifecycle !== 'orphaned' && existing.lifecycle !== 'deleted')
      )
        return false;
      if (!existing.serverUrl || existing.serverUrl !== record.serverUrl)
        return false;
      // Transfer ownership without replacing the record while an adapter
      // close is in flight. The old operation must settle before any retry.
      if (existing.closePromise) {
        if (!existing.latePaneCleanup) {
          existing.owner = record.owner;
          if (record.ownerGeneration !== undefined)
            existing.ownerGeneration = record.ownerGeneration;
        }
        return false;
      }
      const settlement = this.consumeCloseSettlement(existing);
      if (settlement?.closed) {
        existing.closeTimer?.cancel();
        existing.closeTimer = undefined;
        records().delete(existing.session);
        return false;
      }
      existing.closeTimer?.cancel();
      const nextOwner = record.owner;
      const nextOwnerGeneration =
        record.ownerGeneration ?? existing.ownerGeneration;
      Object.assign(record, existing, {
        owner: nextOwner,
        ownerGeneration: nextOwnerGeneration,
        closeTimer: undefined,
      });
    }
    records().set(record.session, record);
    this.notifyLatePaneOrphan(record);
    return true;
  }
  get(session: string): CmuxSessionRecord | undefined {
    return records().get(session);
  }
  ownedBy(owner: string): CmuxSessionRecord[] {
    return [...records().values()].filter((record) => record.owner === owner);
  }
  observeLatePaneOrphans(
    directory: string,
    serverUrl: string | (() => string | undefined),
    callback: (record: CmuxSessionRecord) => void,
    ownerGeneration = 0,
  ): () => void {
    const observer = { directory, serverUrl, callback, ownerGeneration };
    orphanObservers().add(observer);
    return () => orphanObservers().delete(observer);
  }
  notifyLatePaneOrphan(record: CmuxSessionRecord): void {
    if (!record.latePaneCleanup || !record.paneId || !record.serverUrl) return;
    for (const observer of orphanObservers()) {
      if (observer.directory !== record.directory) continue;
      const serverUrl =
        typeof observer.serverUrl === 'function'
          ? observer.serverUrl()
          : observer.serverUrl;
      if (serverUrl !== record.serverUrl) continue;
      queueMicrotask(() => {
        if (orphanObservers().has(observer)) observer.callback(record);
      });
    }
  }
  claimOrphans(
    owner: string,
    directory: string,
    serverUrl?: string | (() => string | undefined),
    ownerGeneration?: number,
  ): CmuxSessionRecord[] {
    const currentServerUrl =
      serverUrl === undefined
        ? undefined
        : typeof serverUrl === 'function'
          ? serverUrl()
          : serverUrl;
    if (!currentServerUrl) return [];
    const claimed = [...records().values()].filter(
      (record) =>
        record.directory === directory &&
        record.serverUrl === currentServerUrl &&
        Boolean(record.paneId) &&
        (!record.latePaneCleanup || !record.closePromise) &&
        (record.lifecycle === 'orphaned' || record.lifecycle === 'deleted'),
    );
    for (const record of claimed) {
      record.closeTimer?.cancel();
      record.closeTimer = undefined;
      record.owner = owner;
      if (ownerGeneration !== undefined)
        record.ownerGeneration = ownerGeneration;
    }
    return claimed;
  }
  claimLatePaneOrphans(
    owner: string,
    directory: string,
    serverUrl: string,
    ownerGeneration?: number,
    expectedRecord?: CmuxSessionRecord,
  ): CmuxSessionRecord[] {
    const claimed = [...records().values()].filter(
      (record) =>
        (!expectedRecord || record === expectedRecord) &&
        record.owner !== owner &&
        record.latePaneCleanup === true &&
        record.directory === directory &&
        record.serverUrl === serverUrl &&
        Boolean(record.paneId) &&
        !record.closePromise &&
        (ownerGeneration === undefined ||
          record.ownerGeneration === undefined ||
          record.ownerGeneration < ownerGeneration) &&
        (record.lifecycle === 'orphaned' || record.lifecycle === 'deleted'),
    );
    for (const record of claimed) {
      record.closeTimer?.cancel();
      record.closeTimer = undefined;
      record.owner = owner;
      if (ownerGeneration !== undefined)
        record.ownerGeneration = ownerGeneration;
    }
    return claimed;
  }
  markAttached(session: string, paneId: string, now: number): void {
    const record = records().get(session);
    if (!record) return;
    Object.assign(record, {
      paneId,
      attachedAt: now,
      lastActivityAt: now,
      spawnState: 'attached',
      deferredSpawn: undefined,
    });
  }
  markActivity(session: string, now: number): void {
    const record = records().get(session);
    if (!record) return;
    record.lastActivityAt = now;
    record.activityVersion += 1;
    record.idleConsecutive = 0;
    record.statusMissingSince = undefined;
  }
  markDeleted(session: string): void {
    const record = records().get(session);
    if (record) record.lifecycle = 'deleted';
  }
  markOrphaned(session: string): void {
    const record = records().get(session);
    if (record) record.lifecycle = 'orphaned';
  }
  removeAfterConfirmedClose(session: string): boolean {
    const record = records().get(session);
    return record?.paneId ? records().delete(session) : false;
  }
  removeWithoutPane(session: string): boolean {
    const record = records().get(session);
    return record && !record.paneId ? records().delete(session) : false;
  }
  resetForTests(): void {
    for (const record of records().values()) {
      record.deferredSpawn?.timer?.cancel();
      record.closeTimer?.cancel();
    }
    records().clear();
    orphanObservers().clear();
    const globalStore = globalThis as typeof globalThis & {
      [OWNER_GENERATION_KEY]?: number;
    };
    globalStore[OWNER_GENERATION_KEY] = 0;
  }
}
