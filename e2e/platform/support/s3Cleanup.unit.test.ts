import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { deleteS3Prefix } from "./server.ts";

describe("platform E2E S3 prefix cleanup", () => {
  it("deletes every page and follows an explicit continuation token", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ IsTruncated: true, NextContinuationToken: "page-2", Contents: [{ Key: "prefix/a" }] })
      .mockResolvedValueOnce({ Errors: [] })
      .mockResolvedValueOnce({ IsTruncated: false, Contents: [{ Key: "prefix/b" }] })
      .mockResolvedValueOnce({});

    await deleteS3Prefix({ send } as never, "pdf-approval", "prefix");

    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(ListObjectsV2Command);
    expect(send.mock.calls[1]![0]).toBeInstanceOf(DeleteObjectsCommand);
    expect((send.mock.calls[2]![0] as ListObjectsV2Command).input.ContinuationToken).toBe("page-2");
  });

  it("fails when DeleteObjects reports any partial error", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ IsTruncated: false, Contents: [{ Key: "prefix/a" }] })
      .mockResolvedValueOnce({ Errors: [{ Key: "prefix/a", Code: "AccessDenied" }] });
    await expect(deleteS3Prefix({ send } as never, "pdf-approval", "prefix"))
      .rejects.toThrow("PLATFORM_E2E_S3_PREFIX_DELETE_FAILED");
  });

  it("fails closed when a truncated listing omits its continuation token", async () => {
    const send = vi.fn().mockResolvedValueOnce({ IsTruncated: true, Contents: [] });
    await expect(deleteS3Prefix({ send } as never, "pdf-approval", "prefix"))
      .rejects.toThrow("PLATFORM_E2E_S3_PAGINATION_INVALID");
    expect(send).toHaveBeenCalledOnce();
  });
});
