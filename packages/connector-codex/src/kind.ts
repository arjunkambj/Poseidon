/**
 * The connector kind this package registers — the settings document's
 * `kind` for an instance of it. Its own module so the probe and the session
 * can name it without importing the definition that wires them.
 */
export const CODEX_KIND = "codex";
