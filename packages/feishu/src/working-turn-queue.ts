/** FIFO for admitted card-owning turns. Transport admission stays independent of execution. */
const waiters = new Map<string, Map<AbortController, string>>();

export function cancelFeishuWaitingTurns(key: string, senderId: string): void {
  for (const [controller, sender] of waiters.get(key) ?? []) {
    if (sender === senderId) controller.abort();
  }
}

const tails = new Map<string, Promise<void>>();

export async function runFeishuWorkingTurn(params: {
  key: string;
  senderId: string;
  signal?: AbortSignal;
  prepare: (queued: boolean) => Promise<void>;
  run: () => Promise<void>;
  cancel: (reason: "cancelled" | "failed") => Promise<void>;
}): Promise<void> {
  const controller = new AbortController();
  const signal = params.signal ? AbortSignal.any([controller.signal, params.signal]) : controller.signal;
  const pending = waiters.get(params.key) ?? new Map<AbortController, string>();
  pending.set(controller, params.senderId);
  waiters.set(params.key, pending);
  const removeWaiter = () => {
    pending.delete(controller);
    if (!pending.size && waiters.get(params.key) === pending) waiters.delete(params.key);
  };
  const previous = tails.get(params.key);
  let release!: () => void;
  const finished = new Promise<void>((resolve) => { release = resolve; });
  // A cancelled waiter must not allow a later request to overtake its predecessor.
  const tail = Promise.all([previous, finished]).then(() => {});
  tails.set(params.key, tail);
  const cleanup = () => { if (tails.get(params.key) === tail) tails.delete(params.key); };
  void tail.then(cleanup);
  let abort!: () => void;
  const aborted = new Promise<void>((resolve) => { abort = resolve; });
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) return await params.cancel("cancelled");
    await params.prepare(Boolean(previous));
    await Promise.race([previous ?? Promise.resolve(), aborted]);
    if (signal.aborted) return await params.cancel("cancelled");
    removeWaiter();
    await params.run();
  } catch (error) {
    await Promise.resolve(params.cancel("failed")).catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    removeWaiter();
    release();
  }
}
