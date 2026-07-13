export type IdentityOperationKey =
  | "sessionLoad"
  | "login"
  | "mfa"
  | "invitationPrepare"
  | "invitationComplete"
  | "logout";

export type IdentityOperationLease = Readonly<{
  readonly signal: AbortSignal;
  readonly owns: () => boolean;
}>;

type OperationEntry = {
  readonly generation: number;
  readonly controller: AbortController;
  promise?: Promise<unknown>;
};

export function createIdentityOperationRegistry() {
  let generation = 0;
  const entries = new Map<IdentityOperationKey, OperationEntry>();

  function start<T>(key: IdentityOperationKey, operation: (lease: IdentityOperationLease) => Promise<T>) {
    const entry: OperationEntry = { generation, controller: new AbortController() };
    let resolveCurrent!: (value: T | PromiseLike<T>) => void;
    let rejectCurrent!: (reason?: unknown) => void;
    const current = new Promise<T>((resolve, reject) => {
      resolveCurrent = resolve;
      rejectCurrent = reject;
    });
    entry.promise = current;
    entries.set(key, entry);
    const lease: IdentityOperationLease = Object.freeze({
      signal: entry.controller.signal,
      owns: () => generation === entry.generation && entries.get(key) === entry && !entry.controller.signal.aborted
    });
    try {
      void Promise.resolve(operation(lease)).then(resolveCurrent, rejectCurrent);
    } catch (error) {
      rejectCurrent(error);
    }
    void current.then(
      () => { if (entries.get(key) === entry) entries.delete(key); },
      () => { if (entries.get(key) === entry) entries.delete(key); }
    );
    return current;
  }

  function run<T>(key: IdentityOperationKey, operation: (lease: IdentityOperationLease) => Promise<T>): Promise<T> {
    const existing = entries.get(key);
    return existing?.promise ? existing.promise as Promise<T> : start(key, operation);
  }

  function clear() {
    generation += 1;
    for (const entry of entries.values()) entry.controller.abort();
    entries.clear();
  }

  return Object.freeze({
    run,
    runAfterClear<T>(key: "logout", operation: (lease: IdentityOperationLease) => Promise<T>): Promise<T> {
      const existing = entries.get(key);
      if (existing?.promise) return existing.promise as Promise<T>;
      clear();
      return start(key, operation);
    },
    clear
  });
}

export async function runOwnedIdentityRequest<T>(
  lease: IdentityOperationLease,
  request: (signal: AbortSignal) => Promise<T>,
  handlers: {
    readonly onSuccess: (value: T) => void;
    readonly onFailure: (error: unknown) => void;
    readonly onSettled: () => void;
  }
) {
  try {
    const value = await request(lease.signal);
    if (lease.owns()) handlers.onSuccess(value);
  } catch (error) {
    if (lease.owns()) handlers.onFailure(error);
  } finally {
    if (lease.owns()) handlers.onSettled();
  }
}
