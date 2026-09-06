/**
 * Multiplexer module exports
 */

export type { CmuxClient, CommandRunner } from './cmux';
export { CliCmuxClient, CmuxMultiplexer } from './cmux';
export {
  getMultiplexer,
  startAvailabilityCheck,
} from './factory';
export { HerdrMultiplexer } from './herdr';
export { KittyMultiplexer } from './kitty';
export {
  MultiplexerSessionManager,
  TmuxSessionManager,
} from './session-manager';
export type { SessionReadinessOptions } from './shared';
export { waitForSessionReady } from './shared';
export { TmuxMultiplexer } from './tmux';
export type { Multiplexer, PaneResult } from './types';
export { isServerRunning } from './types';
export { ZellijMultiplexer } from './zellij';
