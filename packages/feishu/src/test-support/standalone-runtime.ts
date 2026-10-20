// Adapted test fixtures from OpenClaw; see repository LICENSE.
// Builds plugin runtime environment fixtures for plugin tests.
import type { OutputRuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { vi } from "vitest";

type RuntimeEnvOptions = {
  throwOnExit?: boolean;
};

/** Creates a plugin runtime env with test-safe defaults and optional exit throwing. */
export function createRuntimeEnv(options?: RuntimeEnvOptions): OutputRuntimeEnv {
  const throwOnExit = options?.throwOnExit ?? true;
  return {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: throwOnExit
      ? vi.fn((code: number): never => {
          throw new Error(`exit ${code}`);
        })
      : vi.fn(),
  };
}

export function createNonExitingRuntimeEnv(): OutputRuntimeEnv {
  return createRuntimeEnv({ throwOnExit: false });
}

export const createTestInboundDebounceFlush: (params: any) => any = (params) => {
  const source = params.lifecycle;
  const completion = params.dispatch({
    abortSignal: source?.abortSignal ?? new AbortController().signal,
    onAdopted: async () => await source?.onAdopted?.(),
    onDeferred: () => source?.onDeferred?.(),
    onDeferredHeartbeat: () => source?.onDeferredHeartbeat?.(),
    deferredHeartbeatIntervalMs: source?.deferredHeartbeatIntervalMs,
    onAdoptionFinalizing: () => source?.onAdoptionFinalizing?.(),
    onFailed: source?.onFailed ? async (error) => await source.onFailed?.(error) : undefined,
    onAbandoned: async () => await source?.onAbandoned?.(),
  });
  return { admission: completion, completion };
};
