import { describe, expect, test } from 'bun:test';
import { createBuiltinMcps } from './index';

describe('createBuiltinMcps', () => {
  test('returns all MCPs when no disabled list provided', () => {
    const mcps = createBuiltinMcps();
    const names = Object.keys(mcps);

    expect(names).toContain('context7');
    expect(names).toContain('gh_grep');
  });

  test('returns all MCPs with empty disabled list', () => {
    const mcps = createBuiltinMcps([]);
    const names = Object.keys(mcps);

    expect(names.length).toBe(2);
    expect(names).toContain('context7');
    expect(names).toContain('gh_grep');
  });

  test('excludes single disabled MCP', () => {
    const mcps = createBuiltinMcps(['gh_grep']);
    const names = Object.keys(mcps);

    expect(names).not.toContain('gh_grep');
    expect(names).toContain('context7');
  });

  test('excludes multiple disabled MCPs', () => {
    const mcps = createBuiltinMcps(['gh_grep', 'context7']);
    const names = Object.keys(mcps);

    expect(names).not.toContain('gh_grep');
    expect(names).not.toContain('context7');
    expect(names.length).toBe(0);
  });

  test('excludes all MCPs when all disabled', () => {
    const mcps = createBuiltinMcps(['context7', 'gh_grep']);
    const names = Object.keys(mcps);

    expect(names.length).toBe(0);
  });

  test('ignores unknown MCP names in disabled list', () => {
    const mcps = createBuiltinMcps(['unknown_mcp', 'nonexistent']);
    const names = Object.keys(mcps);

    // All valid MCPs should still be present
    expect(names.length).toBe(2);
    expect(names).toContain('context7');
    expect(names).toContain('gh_grep');
  });

  test('MCP configs have required properties', () => {
    const mcps = createBuiltinMcps();

    for (const [_name, config] of Object.entries(mcps)) {
      expect(config).toBeDefined();
      // Each MCP should have either url (remote) or command (local)
      const hasUrl = 'url' in config;
      const hasCommand = 'command' in config;
      expect(hasUrl || hasCommand).toBe(true);
    }
  });

  test('context7 MCP has correct structure', () => {
    const mcps = createBuiltinMcps();
    const context7 = mcps.context7;

    expect(context7).toBeDefined();
    expect('url' in context7).toBe(true);
  });

  test('gh_grep MCP has correct structure', () => {
    const mcps = createBuiltinMcps();
    const gh_grep = mcps.gh_grep;

    expect(gh_grep).toBeDefined();
    expect('url' in gh_grep).toBe(true);
  });

  test('never throws when disabledMcps is not an array', () => {
    // Regression test: a malformed/non-array config.disabled_mcps value
    // must degrade to "nothing disabled" instead of crashing plugin init.
    const mcps = createBuiltinMcps('' as any);
    const names = Object.keys(mcps);

    expect(names.length).toBe(2);
    expect(names).toContain('context7');
    expect(names).toContain('gh_grep');
  });
});
