import { describe, expect, it } from "vitest";
import {
  createWebDavConnectionRequestSchema,
  createWebDavMappingRequestSchema,
  resolveWebDavConflictRequestSchema,
  webDavConflictResponseSchema,
  webDavRemotePathSchema
} from "./webdav.ts";

const ids = {
  connection: "01890f1e-9b4a-7cc2-8f00-000000000301",
  project: "01890f1e-9b4a-7cc2-8f00-000000000302",
  mapping: "01890f1e-9b4a-7cc2-8f00-000000000303",
  conflict: "01890f1e-9b4a-7cc2-8f00-000000000304",
  syncItem: "01890f1e-9b4a-7cc2-8f00-000000000305",
  revision: "01890f1e-9b4a-7cc2-8f00-000000000306"
} as const;

describe("Phase 5 WebDAV contracts", () => {
  it("normalizes endpoints without accepting credentials, query strings or fragments", () => {
    expect(createWebDavConnectionRequestSchema.parse({
      name: " 坚果云图纸交换 ",
      endpointUrl: "https://dav.example.test/root/",
      credentialRef: "secret/webdav/nutstore",
      reason: "首次接入",
      idempotencyKey: "webdav:connection:create:1"
    })).toMatchObject({
      name: "坚果云图纸交换",
      endpointUrl: "https://dav.example.test/root/",
      credentialRef: "secret/webdav/nutstore"
    });
    for (const endpointUrl of [
      "https://user:pass@dav.example.test/",
      "https://dav.example.test/?token=secret",
      "https://dav.example.test/#fragment",
      "ftp://dav.example.test/"
    ]) {
      expect(createWebDavConnectionRequestSchema.safeParse({
        name: "连接", endpointUrl, credentialRef: "secret/webdav/test", reason: "测试",
        idempotencyKey: "webdav:connection:create:2"
      }).success).toBe(false);
    }
  });

  it("accepts normalized absolute remote paths and rejects traversal or ambiguous separators", () => {
    expect(webDavRemotePathSchema.parse("/Incoming/项目 A")).toBe("/Incoming/项目 A");
    for (const path of ["Incoming", "/Incoming/../Published", "/Incoming//A", "/", "/Incoming\\A"])
      expect(webDavRemotePathSchema.safeParse(path).success).toBe(false);
  });

  it("requires non-overlapping project mappings and bounded scan settings", () => {
    expect(createWebDavMappingRequestSchema.parse({
      connectionId: ids.connection,
      projectId: ids.project,
      incomingPath: "/Incoming/GX",
      outgoingPath: "/Published/GX",
      publishVariant: "signed",
      scanIntervalSeconds: 300,
      reason: "项目接入",
      idempotencyKey: "webdav:mapping:create:1"
    })).toMatchObject({ publishVariant: "signed", scanIntervalSeconds: 300 });
    expect(createWebDavMappingRequestSchema.safeParse({
      connectionId: ids.connection, projectId: ids.project,
      incomingPath: "/Drawings", outgoingPath: "/Drawings/Published",
      publishVariant: "signed", scanIntervalSeconds: 10, reason: "错误映射",
      idempotencyKey: "webdav:mapping:create:2"
    }).success).toBe(false);
  });

  it("requires an explicit conflict decision, reason and optimistic version", () => {
    expect(resolveWebDavConflictRequestSchema.parse({
      resolution: "publish_cloud_as_renamed",
      renamedRemotePath: "/Published/GX/A01-cloud.pdf",
      reason: "保留远端文件并发布云端权威版本",
      version: 2,
      idempotencyKey: "webdav:conflict:resolve:1"
    })).toMatchObject({ resolution: "publish_cloud_as_renamed", version: 2 });
    expect(resolveWebDavConflictRequestSchema.safeParse({
      resolution: "publish_cloud_as_renamed", renamedRemotePath: null, reason: "确认", version: 2,
      idempotencyKey: "webdav:conflict:resolve:2"
    }).success).toBe(false);
  });

  it("returns both sides of an open conflict without credential material", () => {
    const value = webDavConflictResponseSchema.parse({
      id: ids.conflict, projectId: ids.project, mappingId: ids.mapping, syncItemId: ids.syncItem,
      direction: "outbound", remotePath: "/Published/GX/A01.pdf", status: "open", resolution: null,
      resolutionReason: null, renamedRemotePath: null, version: 1,
      remote: { etag: "\"remote-v2\"", sizeBytes: 1200,
        modifiedAt: "2026-07-14T10:00:00.000Z", sha256: "a".repeat(64) },
      cloud: { revisionId: ids.revision, objectId: null, sizeBytes: 1180, sha256: "b".repeat(64) },
      createdAt: "2026-07-14T10:01:00.000Z", updatedAt: "2026-07-14T10:01:00.000Z",
      resolvedAt: null, resolvedByUserId: null
    });
    expect(JSON.stringify(value)).not.toMatch(/credential|password|authorization/i);
  });
});
