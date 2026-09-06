export const GOAL_AUTO_CREATE_SUPPRESSION_METADATA_KEY =
  'oh-my-opencode-slim.goalAutoCreateSuppressed';

export interface GoalAutoCreateMessagePart {
  type?: unknown;
  text?: unknown;
  synthetic?: unknown;
  metadata?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSuppressed(part: GoalAutoCreateMessagePart): boolean {
  return (
    isRecord(part.metadata) &&
    part.metadata[GOAL_AUTO_CREATE_SUPPRESSION_METADATA_KEY] === true
  );
}

/** Extracts user-authored text suitable for a V1 automatic Goal objective. */
export function extractGoalAutoCreateObjective(
  parts: readonly GoalAutoCreateMessagePart[],
): string | null {
  if (parts.some(isSuppressed)) return null;

  const text = parts
    .filter(
      (part) =>
        part.type === 'text' &&
        part.synthetic !== true &&
        typeof part.text === 'string',
    )
    .map((part) => (part.text as string).trim())
    .filter(Boolean)
    .join('\n\n');

  return text && !text.startsWith('/') ? text : null;
}
