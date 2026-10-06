// Reads a webhook body without buffering more than maxBytes, so signature
// checks see the exact bytes the sender signed. Returns null when it is larger.
export async function readWebhookPayload(request: Request, maxBytes: number) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return null;
  }
  if (request.body === null) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return bytes.slice(0, total).buffer;
      if (total + value.byteLength > maxBytes) {
        void reader
          .cancel("Webhook payload exceeded the limit.")
          .catch(() => undefined);
        return null;
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}
