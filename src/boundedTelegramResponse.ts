import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";

export class ResponseBodyLimitExceededError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Telegram response body exceeds ${maxBytes} bytes.`);
    this.name = "ResponseBodyLimitExceededError";
  }
}

export class ResponseBodyStorageLimitExceededError extends Error {
  constructor(readonly maxStoredBytes: number) {
    super(`Telegram response body exceeds the remaining ${maxStoredBytes} byte storage budget.`);
    this.name = "ResponseBodyStorageLimitExceededError";
  }
}

export function getResponseContentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length")?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

export async function readResponseBytesBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  validateLimit(maxBytes);
  await rejectOversizedDeclaredBody(response, maxBytes);
  if (!response.body) return new Uint8Array();

  const bytes = new Uint8Array(maxBytes);
  const reader = response.body.getReader();
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (byteLength + value.byteLength > maxBytes) {
        await cancelReader(reader);
        throw new ResponseBodyLimitExceededError(maxBytes);
      }
      bytes.set(value, byteLength);
      byteLength += value.byteLength;
    }
  } catch (error) {
    if (!(error instanceof ResponseBodyLimitExceededError)) await cancelReader(reader);
    throw error;
  } finally {
    reader.releaseLock();
  }

  return bytes.subarray(0, byteLength);
}

export async function streamResponseToFileBounded(
  response: Response,
  filePath: string,
  maxBytes: number,
  maxStoredBytes = maxBytes
): Promise<{ byteLength: number; sha256: string }> {
  validateLimit(maxBytes);
  validateLimit(maxStoredBytes);
  await rejectOversizedDeclaredBody(response, maxBytes);
  if (!response.body) return { byteLength: 0, sha256: `sha256:${createHash("sha256").digest("hex")}` };

  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  let byteLength = 0;
  let storageLimitExceeded = false;
  try {
    handle = await open(filePath, "wx", 0o600);
    created = true;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (byteLength + value.byteLength > maxBytes) {
        await cancelReader(reader);
        throw new ResponseBodyLimitExceededError(maxBytes);
      }
      const storedLength = Math.min(value.byteLength, Math.max(0, maxStoredBytes - byteLength));
      if (storedLength < value.byteLength) storageLimitExceeded = true;
      if (storedLength > 0) {
        const storedChunk = value.subarray(0, storedLength);
        await writeAll(handle, storedChunk);
        hash.update(storedChunk);
      }
      byteLength += value.byteLength;
    }
    if (storageLimitExceeded) throw new ResponseBodyStorageLimitExceededError(maxStoredBytes);
    const result = { byteLength, sha256: `sha256:${hash.digest("hex")}` };
    await handle.close();
    handle = undefined;
    return result;
  } catch (error) {
    if (!(error instanceof ResponseBodyLimitExceededError)) await cancelReader(reader);
    if (created) await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    await handle?.close().catch(() => undefined);
  }
}

async function rejectOversizedDeclaredBody(response: Response, maxBytes: number): Promise<void> {
  if ((getResponseContentLength(response) ?? 0) <= maxBytes) return;
  await response.body?.cancel().catch(() => undefined);
  throw new ResponseBodyLimitExceededError(maxBytes);
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  await reader.cancel().catch(() => undefined);
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, chunk: Uint8Array): Promise<void> {
  const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error("Could not write Telegram response to disk.");
    offset += bytesWritten;
  }
}

function validateLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative integer.");
}
