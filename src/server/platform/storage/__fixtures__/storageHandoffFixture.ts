import { Readable } from "node:stream";
import type { QueryExecutor } from "../../database/queryExecutor.ts";
import type { StorageAdapter } from "../storageAdapter.ts";
import { StorageError } from "../storageErrors.ts";
import type { StorageObject, StorageObjectRepository } from "../storageObjectRepository.ts";
import { StorageObjectService } from "../storageObjectService.ts";

const mode = process.argv[2];
const handoffError = Object.assign(new Error("sensitive handoff failure"), { code: "HANDOFF_GAP" });
const adapterError = new StorageError("OBJECT_EXISTS", "adapter rejected the object");
const nextImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));
const now = new Date("2026-07-12T00:00:00.000Z");
let readyCalls = 0;
let headCalls = 0;

const repository: StorageObjectRepository = {
  async createStaging(input) {
    return {
      ...input,
      status: "staging",
      sizeBytes: null,
      sha256: null,
      mediaType: null,
      lastError: null,
      updatedAt: input.createdAt,
      readyAt: null,
      deleteRequestedAt: null,
      deletedAt: null,
      uploadExpiresAt: input.uploadExpiresAt
    };
  },
  async markReady(id, content) {
    readyCalls += 1;
    return {
      id,
      status: "ready",
      driver: "filesystem",
      objectKey: `objects/original/${id}`,
      ...content,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      deleteRequestedAt: null,
      deletedAt: null,
      uploadExpiresAt: new Date(now.getTime() + 1)
    } satisfies StorageObject;
  },
  async findById() { return undefined; },
  async markDeletePending() { throw new Error("UNEXPECTED_MARK_DELETE_PENDING"); },
  async listStaleStaging() { return []; },
  async listDeletePending() { return []; },
  async prepareCleanup() { throw new Error("UNEXPECTED_PREPARE_CLEANUP"); },
  async completeCleanup() { throw new Error("UNEXPECTED_COMPLETE_CLEANUP"); }
};

const body = new Readable({ read() {} });
const storage: StorageAdapter = {
  driver: "filesystem",
  async write() {
    await nextImmediate();
    body.destroy(handoffError);
    await nextImmediate();
    if (mode === "reject") throw adapterError;
    return { sizeBytes: 0, sha256: Buffer.alloc(32) };
  },
  async head() {
    headCalls += 1;
    return { sizeBytes: 0 };
  },
  async openRead() { throw new Error("UNEXPECTED_OPEN_READ"); },
  async delete() {},
  async checkHealth() {}
};
const service = new StorageObjectService({
  storage,
  transactionRunner: (callback) => callback({} as QueryExecutor),
  createRepository: () => repository,
  clock: () => now
});

const uncaught: unknown[] = [];
const unhandled: unknown[] = [];
const onUncaught = (error: unknown) => { uncaught.push(error); };
const onUnhandled = (error: unknown) => { unhandled.push(error); };
process.on("uncaughtException", onUncaught);
process.on("unhandledRejection", onUnhandled);

let result: "resolved" | "rejected" = "resolved";
let rejection: unknown;
try {
  await service.create({ body, mediaType: "application/pdf" });
} catch (error) {
  result = "rejected";
  rejection = error;
}

for (let turn = 0; turn < 4; turn += 1) await nextImmediate();
process.removeListener("uncaughtException", onUncaught);
process.removeListener("unhandledRejection", onUnhandled);

const errorField = (error: unknown, field: string) =>
  typeof error === "object" && error !== null && field in error
    ? (error as Record<string, unknown>)[field]
    : undefined;
const cause = errorField(rejection, "cause");
process.stdout.write(JSON.stringify({
  result,
  rejectionIsAdapterError: rejection === adapterError,
  rejectionCode: errorField(rejection, "code"),
  rejectionMessage: errorField(rejection, "message"),
  causeName: errorField(cause, "name"),
  causeCode: errorField(cause, "code"),
  causeMessage: errorField(cause, "message"),
  readyCalls,
  headCalls,
  uncaughtCodes: uncaught.map((error) => errorField(error, "code")),
  unhandledCount: unhandled.length,
  errorListeners: body.listenerCount("error"),
  destroyed: body.destroyed,
  closed: body.closed
}));
