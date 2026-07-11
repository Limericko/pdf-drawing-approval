import { describe, expect, it, vi } from "vitest";
import { withTransaction } from "./transaction.ts";

const transactionTimeouts = {
  queryTimeoutMs: 111,
  lockTimeoutMs: 222,
  transactionTimeoutMs: 333
};

function queryResult() {
  return { command: "", rowCount: 0, oid: 0, fields: [], rows: [] };
}

function transactionFixture() {
  const client = {
    query: vi.fn(async (_text: string, _values?: unknown[]) => queryResult()),
    release: vi.fn()
  };
  const pool = {
    transactionTimeouts,
    connect: vi.fn(async () => client)
  };
  return { client, pool };
}

async function captureError(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("EXPECTED_PROMISE_TO_REJECT");
}

describe("withTransaction", () => {
  it("uses one client, parameterizes local timeouts and commits the callback result", async () => {
    const { client, pool } = transactionFixture();
    const hostileValue = "value'); DROP TABLE test_items; --";

    const result = await withTransaction(pool as never, async (tx) => {
      await tx.query("INSERT INTO test_items(name) VALUES ($1)", [hostileValue]);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(client.query.mock.calls).toEqual([
      ["BEGIN"],
      ["SELECT set_config($1, $2, true)", ["statement_timeout", "111ms"]],
      ["SELECT set_config($1, $2, true)", ["lock_timeout", "222ms"]],
      ["SELECT set_config($1, $2, true)", ["idle_in_transaction_session_timeout", "333ms"]],
      ["INSERT INTO test_items(name) VALUES ($1)", [hostileValue]],
      ["COMMIT"]
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back a callback error, preserves the original error and releases the client", async () => {
    const { client, pool } = transactionFixture();
    const callbackError = new Error("callback failed");

    const thrown = await captureError(() =>
      withTransaction(pool as never, async () => {
        throw callbackError;
      })
    );

    expect(thrown).toBe(callbackError);
    expect(client.query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases when a database query in the callback fails", async () => {
    const { client, pool } = transactionFixture();
    const queryError = Object.assign(new Error("statement failed"), { code: "23505" });
    client.query.mockImplementation(async (text: string) => {
      if (text === "SELECT broken") throw queryError;
      return queryResult();
    });

    const thrown = await captureError(() =>
      withTransaction(pool as never, async (tx) => {
        await tx.query("SELECT broken");
      })
    );

    expect(thrown).toBe(queryError);
    expect(client.query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("keeps the primary error visible when rollback also fails", async () => {
    const { client, pool } = transactionFixture();
    const callbackError = new Error("callback failed");
    const rollbackError = new Error("rollback failed");
    client.query.mockImplementation(async (text: string) => {
      if (text === "ROLLBACK") throw rollbackError;
      return queryResult();
    });

    const thrown = await captureError(() =>
      withTransaction(pool as never, async () => {
        throw callbackError;
      })
    );

    expect(thrown).toBeInstanceOf(AggregateError);
    expect([...(thrown as AggregateError).errors]).toEqual([callbackError, rollbackError]);
    expect((thrown as Error).cause).toBe(callbackError);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("keeps the primary error visible when release also fails", async () => {
    const { client, pool } = transactionFixture();
    const callbackError = new Error("callback failed");
    const releaseError = new Error("release failed");
    client.release.mockImplementation(() => {
      throw releaseError;
    });

    const thrown = await captureError(() =>
      withTransaction(pool as never, async () => {
        throw callbackError;
      })
    );

    expect(thrown).toBeInstanceOf(AggregateError);
    expect([...(thrown as AggregateError).errors]).toEqual([callbackError, releaseError]);
    expect((thrown as Error).cause).toBe(callbackError);
  });

  it("surfaces a release error after an otherwise successful commit", async () => {
    const { client, pool } = transactionFixture();
    const releaseError = new Error("release failed");
    client.release.mockImplementation(() => {
      throw releaseError;
    });

    const thrown = await captureError(() => withTransaction(pool as never, async () => "ok"));

    expect(thrown).toBe(releaseError);
    expect(client.query.mock.calls.at(-1)).toEqual(["COMMIT"]);
  });
});
