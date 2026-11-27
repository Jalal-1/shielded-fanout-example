// A development-only trace of what the app is doing.
//
// `pnpm dev` writes one line per step to .dev-log/diag.log (and the browser
// console), so a stuck or failed transaction can be located exactly. It records
// step names, timings and error text. It never records recipient addresses or
// amounts. A production build contains none of this.

/** Everything useful about an error, including what Midnight.js wrapped. */
export function describeError(error: unknown, depth = 0): unknown {
  if (typeof error !== 'object' || error === null) return String(error);
  const e = error as Record<string | symbol, unknown>;
  // The wallet SDK is built on the `effect` library, which wraps a failure and
  // keeps the real one under this symbol rather than under `cause`.
  const wrapped = e[Symbol.for('effect/Runtime/FiberFailure/Cause')] as { error?: unknown; defect?: unknown } | undefined;
  const cause = e.cause ?? wrapped?.error ?? wrapped?.defect;
  return {
    name: e.name,
    message: e.message,
    code: e.code,
    reason: e.reason,
    stack: typeof e.stack === 'string' ? e.stack.split('\n').slice(0, 6).join('\n') : undefined,
    cause: cause !== undefined && depth < 5 ? describeError(cause, depth + 1) : undefined,
  };
}

const started = Date.now();

/** One line of the on-page activity log. */
export interface ActivityLine {
  readonly time: string;
  readonly text: string;
  readonly failed: boolean;
}

type Listener = (line: ActivityLine) => void;
const listeners = new Set<Listener>();

/** Show every step on the page as it happens. Returns a function to stop. */
export function onActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function diag(step: string, detail?: unknown): void {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  for (const listener of listeners) listener({ time, text: step, failed: step.includes('FAILED') });
  if (!import.meta.env.DEV) return;
  const line = { t: new Date().toISOString(), ms: Date.now() - started, step, detail };
  console.debug('[fanout]', step, detail ?? '');
  try {
    void fetch('/__diag', { method: 'POST', body: JSON.stringify(line), keepalive: true }).catch(() => undefined);
  } catch {
    // Diagnostics must never break the app.
  }
}
