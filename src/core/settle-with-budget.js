/**
 * Run async tasks concurrently with a hard overall time budget.
 *
 * `Promise.all` waits for the slowest task — and waits *forever* if one task
 * never settles (a TCP connect through a dead proxy that never resets, a DNS
 * lookup that hangs). When that fan-out sits on a worker's critical path, one
 * stuck task deadlocks the worker. This guarantees a result within `budgetMs`:
 * tasks that finish keep their resolved (or error) value; tasks still pending
 * at the deadline are filled with a timeout marker so the caller moves on.
 *
 * Results are returned in input order. Timers are injectable for testing.
 *
 * @template T
 * @param {Array<{ label: string, run: () => Promise<T> }>} tasks
 * @param {number} budgetMs Hard ceiling on total wall-clock time.
 * @param {object} [opts]
 * @param {(label: string) => any} [opts.onTimeout] Marker for unfinished tasks.
 * @param {(fn: () => void, ms: number) => any} [opts.setTimer]
 * @param {(id: any) => void} [opts.clearTimer]
 * @returns {Promise<any[]>}
 */
export function settleWithBudget(tasks, budgetMs, {
  onTimeout = (label) => ({ timeout: true, label }),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  return new Promise((resolve) => {
    if (tasks.length === 0) {
      resolve([]);
      return;
    }

    const results = new Array(tasks.length);
    const settled = new Array(tasks.length).fill(false);
    let remaining = tasks.length;
    let finished = false;
    let timer = null;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimer(timer);
      for (let i = 0; i < tasks.length; i++) {
        if (!settled[i]) results[i] = onTimeout(tasks[i].label);
      }
      resolve(results);
    };

    timer = setTimer(finish, budgetMs);

    tasks.forEach((task, i) => {
      Promise.resolve()
        .then(() => task.run())
        .then(
          (value) => { results[i] = value; },
          (err) => { results[i] = { error: err?.message || String(err) }; },
        )
        .finally(() => {
          if (finished) return;
          settled[i] = true;
          remaining -= 1;
          if (remaining === 0) finish();
        });
    });
  });
}
