import { Readable } from "node:stream";
import type { QueryExecutor } from "../../database/queryExecutor.ts";
import type { StorageAdapter } from "../storageAdapter.ts";
import type { StorageObjectRepository } from "../storageObjectRepository.ts";
import { StorageObjectService } from "../storageObjectService.ts";

const scenario = process.argv[2];
const earlyError = new Error("EARLY_STREAM_ERROR");
const destroyError = new Error("DESTROY_AFTER_SUPER_FAILED");
const cleanupError = new Error("ASYNC_STREAM_CLEANUP_FAILED");

class CleanupRaceReadable extends Readable {
  override _read() {}

  override _destroy(_error: Error | null, callback: (error?: Error | null) => void) {
    setImmediate(() => {
      if (scenario === "early-error") this.emit("error", earlyError);
      if (scenario === "early-close") this.emit("close");
      setImmediate(() => callback(cleanupError));
    });
  }

  override destroy(error?: Error): this {
    if (scenario !== "super-then-throw") return super.destroy(error);
    super.destroy(error);
    throw destroyError;
  }
}

const body = new CleanupRaceReadable();
const uncaught: unknown[] = [];
const unhandled: unknown[] = [];
const onUncaught = (error: unknown) => { uncaught.push(error); };
const onUnhandled = (error: unknown) => { unhandled.push(error); };
process.on("uncaughtException", onUncaught);
process.on("unhandledRejection", onUnhandled);

if (scenario === "already-destroying") body.destroy();

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

for (let turn = 0; turn < 4; turn += 1) {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
process.removeListener("uncaughtException", onUncaught);
process.removeListener("unhandledRejection", onUnhandled);

const aggregate = rejection instanceof AggregateError ? rejection : undefined;
const primary = aggregate?.errors[0] as { code?: string } | undefined;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : typeof error;
process.stdout.write(JSON.stringify({
  aggregate: aggregate !== undefined,
  primaryCode: primary?.code,
  causeIsPrimary: aggregate?.cause === primary,
  cleanupMessages: aggregate?.errors.slice(1).map(errorMessage) ?? [],
  uncaughtMessages: uncaught.map(errorMessage),
  unhandledCount: unhandled.length,
  errorListeners: body.listenerCount("error"),
  closeListeners: body.listenerCount("close"),
  destroyed: body.destroyed,
  closed: body.closed
}));
