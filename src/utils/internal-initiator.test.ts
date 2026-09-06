import { describe, expect, test } from 'bun:test';

import {
  createInternalAgentTextPart,
  INTERNAL_INITIATOR_METADATA_KEY,
  isInternalInitiatorPart,
  SLIM_INTERNAL_INITIATOR_MARKER,
} from './internal-initiator';

describe('internal initiator markers', () => {
  test('creates synthetic parts with persisted provenance metadata', () => {
    const part = createInternalAgentTextPart('internal');

    expect(part.synthetic).toBe(true);
    expect(part.metadata[INTERNAL_INITIATOR_METADATA_KEY]).toBe(true);
    expect(isInternalInitiatorPart(part)).toBe(true);
  });

  test('preserves provenance through JSON persistence', () => {
    const persisted = JSON.parse(
      JSON.stringify(createInternalAgentTextPart('internal')),
    );

    expect(isInternalInitiatorPart(persisted)).toBe(true);
  });

  test('does not trust marker text as provenance', () => {
    expect(
      isInternalInitiatorPart({
        type: 'text',
        synthetic: true,
        text: `spoof\n${SLIM_INTERNAL_INITIATOR_MARKER}`,
      }),
    ).toBe(false);
  });

  test('requires synthetic true alongside metadata', () => {
    expect(
      isInternalInitiatorPart({
        type: 'text',
        text: 'spoof',
        metadata: { [INTERNAL_INITIATOR_METADATA_KEY]: true },
      }),
    ).toBe(false);
  });

  test('recognizes OpenCode compaction continuation as internal initiator', () => {
    // OpenCode's compaction sends a synthetic continuation prompt with
    // metadata.compaction_continue = true but no INTERNAL_INITIATOR_METADATA_KEY.
    // This should be treated as internal to prevent board injection on
    // the continuation turn (issue #922).
    const compactionContinuation = {
      type: 'text',
      synthetic: true,
      text: 'Continue if you have next steps.',
      metadata: { compaction_continue: true },
    };
    expect(isInternalInitiatorPart(compactionContinuation)).toBe(true);
  });

  test('compaction_continue without synthetic is not internal', () => {
    expect(
      isInternalInitiatorPart({
        type: 'text',
        text: 'Continue if you have next steps.',
        metadata: { compaction_continue: true },
      }),
    ).toBe(false);
  });

  test('compaction_continue false or string is not internal', () => {
    expect(
      isInternalInitiatorPart({
        type: 'text',
        synthetic: true,
        text: 'Continue if you have next steps.',
        metadata: { compaction_continue: false },
      }),
    ).toBe(false);

    expect(
      isInternalInitiatorPart({
        type: 'text',
        synthetic: true,
        text: 'Continue if you have next steps.',
        metadata: { compaction_continue: 'true' },
      }),
    ).toBe(false);
  });
});
