export function assertFeishuApiSuccess(
  response: { code?: number; msg?: string },
  errorPrefix: string,
): void {
  if (response.code !== 0) {
    throw Object.assign(new Error(`${errorPrefix}: ${response.msg || `code ${response.code}`}`), { code: response.code });
  }
}

/** Only a structured card-validation rejection proves that no card was created. */
export function isFeishuCardValidationRejection(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    const value = error as { code?: unknown; response?: { data?: { code?: unknown } }; cause?: unknown };
    if (value.code === 230099 || value.response?.data?.code === 230099) return true;
    error = value.cause;
  }
  return false;
}
