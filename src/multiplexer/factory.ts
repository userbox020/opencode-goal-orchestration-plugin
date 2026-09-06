/**
 * Multiplexer factory - creates the appropriate multiplexer instance
 */

import type { MultiplexerConfig, MultiplexerType } from '../config/schema';
import { log } from '../utils/logger';
import { CmuxMultiplexer } from './cmux';
import { HerdrMultiplexer } from './herdr';
import { KittyMultiplexer } from './kitty';
import { TmuxMultiplexer } from './tmux';
import type { Multiplexer } from './types';
import { ZellijMultiplexer } from './zellij';

/**
 * Create a multiplexer instance based on config.
 *
 * Do not cache instances: tmux/zellij/herdr integrations may depend on
 * per-process environment like TMUX_PANE/ZELLIJ/HERDR_PANE_ID, which should
 * be captured fresh for each plugin context.
 */
export function getMultiplexer(config: MultiplexerConfig): Multiplexer | null {
  const { type } = config;

  if (type === 'none') {
    return null;
  }

  // Create new instance
  let multiplexer: Multiplexer;
  let actualType: MultiplexerType;

  switch (type) {
    case 'tmux':
      multiplexer = new TmuxMultiplexer(config.layout, config.main_pane_size);
      actualType = 'tmux';
      break;
    case 'zellij':
      multiplexer = new ZellijMultiplexer(
        config.layout,
        config.main_pane_size,
        config.zellij_pane_mode,
      );
      actualType = 'zellij';
      break;
    case 'herdr':
      multiplexer = new HerdrMultiplexer(config.layout, config.main_pane_size);
      actualType = 'herdr';
      break;
    case 'cmux':
      multiplexer = new CmuxMultiplexer();
      actualType = 'cmux';
      break;
    case 'kitty':
      multiplexer = new KittyMultiplexer(config.layout, config.main_pane_size);
      actualType = 'kitty';
      break;
    case 'auto': {
      // Auto-detect based on environment variables only
      // Note: Does NOT fall back to binary availability checks
      if (
        process.env.CMUX_SOCKET_PATH &&
        process.env.CMUX_WORKSPACE_ID &&
        process.env.CMUX_SURFACE_ID
      ) {
        multiplexer = new CmuxMultiplexer();
        actualType = 'cmux';
      } else if (process.env.TMUX) {
        multiplexer = new TmuxMultiplexer(config.layout, config.main_pane_size);
        actualType = 'tmux';
      } else if (process.env.ZELLIJ) {
        multiplexer = new ZellijMultiplexer(
          config.layout,
          config.main_pane_size,
          config.zellij_pane_mode,
        );
        actualType = 'zellij';
      } else if (process.env.HERDR_ENV || process.env.HERDR_PANE_ID) {
        // Check Herdr before kitty: kitty exports KITTY_PID to every child
        // process, so a user running OpenCode inside kitty with Herdr active
        // would otherwise silently resolve to kitty and fail every spawn
        // (no KITTY_LISTEN_ON). Herdr's env vars are only set when Herdr is
        // actually active, so this is safe to prefer.
        multiplexer = new HerdrMultiplexer(
          config.layout,
          config.main_pane_size,
        );
        actualType = 'herdr';
      } else if (process.env.KITTY_PID || process.env.KITTY_WINDOW_ID) {
        multiplexer = new KittyMultiplexer(
          config.layout,
          config.main_pane_size,
        );
        actualType = 'kitty';
      } else {
        // Not inside any session, disable multiplexer
        log('[multiplexer] auto: not inside any session, disabling');
        return null;
      }
      break;
    }
    default:
      log(`[multiplexer] Unknown type: ${type}`);
      return null;
  }

  log(`[multiplexer] Created ${actualType} instance`);

  return multiplexer;
}

/**
 * Start background availability check for a multiplexer
 */
export function startAvailabilityCheck(config: MultiplexerConfig): void {
  const multiplexer = getMultiplexer(config);
  if (multiplexer) {
    // Fire and forget - don't await
    multiplexer.isAvailable().catch(() => {});
  }
}
