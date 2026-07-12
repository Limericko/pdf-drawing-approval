import { Readable } from "node:stream";
import type { QueryExecutor } from "../../database/queryExecutor.ts";
import type { StorageAdapter } from "../storageAdapter.ts";
import type { StorageObjectRepository } from "../storageObjectRepository.ts";
import { StorageObjectService } from "../storageObjectService.ts";

const cleanupError = new Error("ASYNC_STREAM_CLEANUP_FAILED");

class AsyncCleanupReadable extends Readable {
  override _read() {}

  override _destroy(_error: Error | null, callback: (error?: Error | null) => void) {
    setImmediate(() => callback(cleanupError));
  }
}

const body = new AsyncCleanupReadable();
const uncaught: unknown[] = [];
const unhandled: unknown[] = [];
const onUncaught = (error: unknown) => { uncaught.push(error); };
const onUnhandled = (error: unknown) => { unhandled.push(error); };
process.on("uncaughtException", onUncaught);
process.on("unhandledRejection", onUnhandled);

const service = new StorageObjectService({
  storage: { driver: "filesystem" } as StorageAdapter,
  transactionRunner: async () => { throw new Error("TRANSACTION_SHOULD_NOT_RUN"); },
  createRepository: (_executor: QueryExecutor) => ({}) as StorageObjectRepository
});

let rejection: unknown;
try {
  await service.create({ body, mediaType: "application/pdf\ntext/plain" });
} catch (error) {
  rejection = error;
}

await new Promise<void>((resolve) => setImmediate(resolve));
await new Promise<void>((resolve) => setImmediate(resolve));
process.removeListener("uncaughtException", onUncaught);
process.removeListener("unhandledRejection", onUnhandled);

const aggregate = rejection instanceof AggregateError ? rejection : undefined;
const primary = aggregate?.errors[0] as { code?: string } | undefined;
process.stdout.write(JSON.stringify({
  aggregate: aggregate !== undefined,
  primaryCode: primary?.code,
  causeIsPrimary: aggregate?.cause === primary,
  cleanupIsExpected: aggregate?.errors[1] === cleanupError,
  uncaughtCount: uncaught.length,
  unhandledCount: unhandled.length,
  errorListeners: body.listenerCount("error"),
  closeListeners: body.listenerCount("close"),
  destroyed: body.destroyed
}));
