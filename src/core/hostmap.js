/**
 * Host-map helpers. The host map is user-supplied text persisted in settings;
 * each non-empty, non-comment line is one mapping. Kept pure and dependency-free
 * so the main-process IPC handler can report a count without crashing.
 */

/** Lines that count as a mapping: non-blank and not a `#`/`//` comment. */
export function hostMapLines(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('//'));
}

/** Number of mappings in the host-map text. */
export function countHostMapEntries(text) {
  return hostMapLines(text).length;
}
