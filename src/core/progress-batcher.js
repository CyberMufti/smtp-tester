/**
 * Coalesce a high-frequency stream of items into batched flushes.
 *
 * At large scale a per-item callback (one IPC `send` per credential, say) floods
 * the event loop: millions of messages, each serialized and each triggering work
 * on the far side. This buffers items and flushes them as an array — whenever the
 * buffer reaches `maxBatch`, or `flushIntervalMs` passes with items waiting,
 * whichever comes first. Bounded message rate, bounded render work, same data.
 *
 * Timers are injectable so the flushing is testable without real time.
 *
 * @template T
 * @param {object} opts
 * @param {number} [opts.maxBatch=200] Flush once this many items are buffered.
 * @param {number} [opts.flushIntervalMs=150] Max time a buffered item waits.
 * @param {(batch: T[]) => void} opts.flush Called with the buffered items (never empty).
 * @param {(fn: () => void, ms: number) => any} [opts.setTimer]
 * @param {(id: any) => void} [opts.clearTimer]
 */
export function createProgressBatcher({
  maxBatch = 200,
  flushIntervalMs = 150,
  flush,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let buffer = [];
  let timer = null;

  function cancelTimer() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function doFlush() {
    cancelTimer();
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    flush(batch);
  }

  return {
    /** @param {T} item */
    push(item) {
      buffer.push(item);
      if (buffer.length >= maxBatch) {
        doFlush();
      } else if (timer === null) {
        timer = setTimer(doFlush, flushIntervalMs);
      }
    },
    /** Flush any buffered items now. */
    flush: doFlush,
    /** Flush remaining items and stop (same as flush; present for symmetry with sinks). */
    close: doFlush,
    size: () => buffer.length,
  };
}
