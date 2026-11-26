/**
 * Reads an on/off environment variable. `0` and `false` in any case are off, any other value is
 * on, and an unset or blank variable gives undefined so the caller can pick its own default.
 */
export function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    return undefined;
  }

  return !['0', 'false'].includes(normalized);
}
