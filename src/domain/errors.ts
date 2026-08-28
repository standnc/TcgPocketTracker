/**
 * A domain-level failure with a user-facing message. Framework-free: the
 * domain never throws SQLite/MCP exceptions across its boundary, it returns
 * one of these so the calling adapter decides how to present it.
 */
export interface DomainError {
  ok: false;
  message: string;
}

/** Builds a {@link DomainError}. */
export function fail(message: string): DomainError {
  return { ok: false, message };
}

/** Type guard: narrows a domain result to its failure branch. */
export function isDomainError(value: { ok: boolean }): value is DomainError {
  return value.ok === false;
}
