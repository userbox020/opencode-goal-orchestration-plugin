import { describe, expect, test } from 'bun:test';
import {
  extractGoalAutoCreateObjective,
  GOAL_AUTO_CREATE_SUPPRESSION_METADATA_KEY,
} from './v1-auto-create';

describe('extractGoalAutoCreateObjective', () => {
  test('returns trimmed user-authored text', () => {
    expect(
      extractGoalAutoCreateObjective([{ type: 'text', text: '  Ship it  ' }]),
    ).toBe('Ship it');
  });

  test('joins multiple real text parts with paragraph breaks', () => {
    expect(
      extractGoalAutoCreateObjective([
        { type: 'text', text: ' First criterion ' },
        { type: 'text', text: 'Second criterion' },
      ]),
    ).toBe('First criterion\n\nSecond criterion');
  });

  test('rejects blank, file-only, and image-only parts', () => {
    expect(extractGoalAutoCreateObjective([{ type: 'text', text: '  ' }])).toBeNull();
    expect(extractGoalAutoCreateObjective([{ type: 'file' }])).toBeNull();
    expect(extractGoalAutoCreateObjective([{ type: 'image' }])).toBeNull();
  });

  test('excludes synthetic text while retaining real text', () => {
    expect(
      extractGoalAutoCreateObjective([
        { type: 'file' },
        { type: 'text', text: 'Synthetic', synthetic: true },
        { type: 'text', text: 'Real objective' },
        { type: 'image' },
      ]),
    ).toBe('Real objective');
    expect(
      extractGoalAutoCreateObjective([
        { type: 'text', text: 'Synthetic only', synthetic: true },
      ]),
    ).toBeNull();
  });

  test('rejects slash commands and explicitly suppressed parts', () => {
    expect(
      extractGoalAutoCreateObjective([{ type: 'text', text: ' /goal status' }]),
    ).toBeNull();
    expect(
      extractGoalAutoCreateObjective([
        { type: 'text', text: 'Real objective' },
        {
          type: 'text',
          text: 'Ignored command metadata',
          metadata: { [GOAL_AUTO_CREATE_SUPPRESSION_METADATA_KEY]: true },
        },
      ]),
    ).toBeNull();
  });
});
