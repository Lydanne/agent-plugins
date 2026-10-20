import { expect, it, vi } from "vitest";
import { cancelFeishuWaitingTurns, runFeishuWorkingTurn } from "./working-turn-queue.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

it("prepares waiting UI immediately but executes same-session requests FIFO", async () => {
  const gate = deferred();
  const events: string[] = [];
  const run = (key: string, id: string) => runFeishuWorkingTurn({
    key, senderId: id,
    prepare: async (queued) => { events.push(`${id}:${queued ? "waiting" : "ready"}`); },
    run: async () => { events.push(`${id}:run`); if (id === "a") await gate.promise; },
    cancel: async () => { events.push(`${id}:cancel`); },
  });
  const first = run("fifo", "a");
  await vi.waitFor(() => expect(events).toContain("a:run"));
  const second = run("fifo", "b");
  const third = run("fifo", "c");
  await run("other-session", "d");
  expect(events).toContain("b:waiting");
  expect(events).toContain("c:waiting");
  expect(events).not.toContain("b:run");
  expect(events).toContain("d:run");
  gate.resolve();
  await Promise.all([first, second, third]);
  expect(events.indexOf("b:run")).toBeLessThan(events.indexOf("c:run"));
});

it("cancels only this sender's waiters without running them or overtaking an active predecessor", async () => {
  const gate = deferred();
  const started = deferred();
  const first = runFeishuWorkingTurn({ key: "cancel", senderId: "a", prepare: async () => {},
    run: async () => { started.resolve(); await gate.promise; }, cancel: vi.fn() });
  await started.promise;
  const cancel = vi.fn(); const runCancelled = vi.fn(); const runThird = vi.fn();
  const second = runFeishuWorkingTurn({ key: "cancel", senderId: "a", prepare: async () => {}, run: runCancelled, cancel });
  const third = runFeishuWorkingTurn({ key: "cancel", senderId: "b", prepare: async () => {}, run: runThird, cancel: vi.fn() });
  cancelFeishuWaitingTurns("cancel", "a");
  await second;
  expect(cancel).toHaveBeenCalledOnce();
  expect(runCancelled).not.toHaveBeenCalled();
  expect(runThird).not.toHaveBeenCalled();
  gate.resolve(); await Promise.all([first, third]);
  expect(runThird).toHaveBeenCalledOnce();
});

it("releases failed turns and aborts waiting ingress without poisoning successors", async () => {
  const gate = deferred(); const signal = new AbortController(); const cancelled = vi.fn();
  const first = runFeishuWorkingTurn({ key: "fail", senderId: "a", prepare: async () => {},
    run: async () => { await gate.promise; throw new Error("failed"); }, cancel: vi.fn() });
  const firstResult = expect(first).rejects.toThrow("failed");
  const second = runFeishuWorkingTurn({ key: "fail", senderId: "b", signal: signal.signal,
    prepare: async () => {}, run: vi.fn(), cancel: cancelled });
  signal.abort(); await second;
  expect(cancelled).toHaveBeenCalledOnce();
  gate.resolve(); await firstResult;
  const run = vi.fn();
  await runFeishuWorkingTurn({ key: "fail", senderId: "c", prepare: async () => {}, run, cancel: vi.fn() });
  expect(run).toHaveBeenCalledOnce();
});
