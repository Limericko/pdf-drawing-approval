import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api.ts";
import { setServerBaseUrl } from "./clientConfig.ts";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  });
});

describe("getSignedFileUrl", () => {
  it("adds a cache key so regenerated signed PDFs open with the latest file", () => {
    api.setToken("token value");

    expect(api.getSignedFileUrl(4, "hash value")).toBe(
      "/api/approvals/4/signed-file?token=token+value&v=hash+value"
    );

    api.clearToken();
  });

  it("uses the configured server base URL for desktop clients", () => {
    setServerBaseUrl("http://192.168.1.20:8080");
    api.setToken("token value");

    expect(api.getSignedFileUrl(4, "hash value")).toBe(
      "http://192.168.1.20:8080/api/approvals/4/signed-file?token=token+value&v=hash+value"
    );

    expect(api.getMySignatureFileUrl()).toBe("http://192.168.1.20:8080/api/signatures/me/file?token=token%20value");

    expect(api.getApprovalFileUrl(4)).toBe("http://192.168.1.20:8080/api/approvals/4/file?token=token%20value");

    expect(api.getApprovalReportCsvUrl({ projectName: "项目A" })).toBe(
      "http://192.168.1.20:8080/api/reports/approvals.csv?projectName=%E9%A1%B9%E7%9B%AEA&token=token+value"
    );
  });
});

describe("approval annotation API", () => {
  it("builds an annotated review PDF URL with token and cache key", () => {
    api.setToken("token value");

    const getAnnotatedFileUrl = (api as unknown as { getAnnotatedFileUrl?: (approvalId: number, cacheKey?: string) => string })
      .getAnnotatedFileUrl;

    expect(getAnnotatedFileUrl).toBeTypeOf("function");
    expect(getAnnotatedFileUrl!(4, "annotations changed")).toBe(
      "/api/approvals/4/annotated-file?token=token+value&v=annotations+changed"
    );
  });

  it("calls expected annotation endpoints", async () => {
    api.setToken("token value");
    const fetchMock = mockJsonFetch({ id: 12, message: "尺寸需确认" });
    const annotationApi = api as unknown as {
      listApprovalAnnotations?: (approvalId: number) => Promise<unknown>;
      createApprovalAnnotation?: (approvalId: number, input: unknown) => Promise<unknown>;
      updateApprovalAnnotation?: (approvalId: number, annotationId: number, input: unknown) => Promise<unknown>;
      resolveApprovalAnnotation?: (approvalId: number, annotationId: number) => Promise<unknown>;
      deleteApprovalAnnotation?: (approvalId: number, annotationId: number) => Promise<unknown>;
    };

    expect(annotationApi.listApprovalAnnotations).toBeTypeOf("function");
    expect(annotationApi.createApprovalAnnotation).toBeTypeOf("function");
    expect(annotationApi.updateApprovalAnnotation).toBeTypeOf("function");
    expect(annotationApi.resolveApprovalAnnotation).toBeTypeOf("function");
    expect(annotationApi.deleteApprovalAnnotation).toBeTypeOf("function");

    const payload: api.ApprovalAnnotationInput = {
      kind: "ink",
      message: "尺寸需确认",
      pageNumber: 1,
      xRatio: 0.1,
      yRatio: 0.2,
      pointsJson: JSON.stringify([
        { xRatio: 0.1, yRatio: 0.2 },
        { xRatio: 0.2, yRatio: 0.3 }
      ]),
      styleJson: JSON.stringify({ strokeWidth: 2 }),
      color: "red"
    };

    await annotationApi.listApprovalAnnotations!(4);
    await annotationApi.createApprovalAnnotation!(4, payload);
    await annotationApi.updateApprovalAnnotation!(4, 12, { ...payload, message: "已调整批注" });
    await annotationApi.resolveApprovalAnnotation!(4, 12);
    await annotationApi.deleteApprovalAnnotation!(4, 12);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/approvals/4/annotations",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token value" })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/approvals/4/annotations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(payload)
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/approvals/4/annotations/12",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ ...payload, message: "已调整批注" })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/approvals/4/annotations/12/resolve",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "/api/approvals/4/annotations/12",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("calls the annotation reset endpoint", async () => {
    api.setToken("token value");
    const fetchMock = mockJsonFetch({ reset: true, deletedCount: 2 });
    const annotationApi = api as unknown as {
      resetApprovalAnnotations?: (approvalId: number) => Promise<unknown>;
    };

    expect(annotationApi.resetApprovalAnnotations).toBeTypeOf("function");
    await annotationApi.resetApprovalAnnotations!(4);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/approvals/4/annotations/reset",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer token value" })
      })
    );
  });
});

describe("desktop API base URL", () => {
  it("uses the configured server base URL for JSON requests", async () => {
    setServerBaseUrl("http://192.168.1.20:8080");
    api.setToken("token value");
    const fetchMock = mockJsonFetch([]);

    await api.listUsers();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.1.20:8080/api/users",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token value"
        })
      })
    );
  });

  it("checks public server health without an auth token", async () => {
    const fetchMock = mockJsonFetch({
      ok: true,
      appName: "PDF图纸审批",
      version: "0.1.0",
      apiCompatVersion: 1,
      port: 8080,
      lanUrls: ["http://192.168.1.20:8080"],
      startedAt: "2026-06-23T00:00:00.000Z"
    });
    const healthApi = api as unknown as { checkServerHealth?: (baseUrl?: string) => Promise<unknown> };

    expect(healthApi.checkServerHealth).toBeTypeOf("function");
    await healthApi.checkServerHealth!("http://192.168.1.20:8080");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.1.20:8080/health",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.not.objectContaining({ Authorization: expect.any(String) })
      })
    );
  });
});

describe("approval list API", () => {
  it("requests paged approvals with server-side filters", async () => {
    api.setToken("token value");
    const fetchMock = mockJsonFetch({ items: [], total: 0, page: 2, pageSize: 25 });
    const approvalApi = api as unknown as {
      listApprovalsPage?: (params: {
        page: number;
        pageSize: number;
        keyword?: string;
        status?: string;
        signatureStatus?: string;
      }) => Promise<unknown>;
    };

    expect(approvalApi.listApprovalsPage).toBeTypeOf("function");
    await approvalApi.listApprovalsPage!({
      page: 2,
      pageSize: 25,
      keyword: "轴承座",
      status: "pending",
      signatureStatus: "failed"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/approvals?page=2&pageSize=25&keyword=%E8%BD%B4%E6%89%BF%E5%BA%A7&status=pending&signatureStatus=failed",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token value" })
      })
    );
  });
});

describe("system cleanup API", () => {
  it("previews and executes cleanup operations", async () => {
    api.setToken("token value");
    const fetchMock = mockJsonFetch({ executed: false, tempUploads: { count: 1 } });
    const cleanupApi = api as unknown as {
      runSystemCleanup?: (execute: boolean) => Promise<unknown>;
    };

    expect(cleanupApi.runSystemCleanup).toBeTypeOf("function");
    await cleanupApi.runSystemCleanup!(false);
    await cleanupApi.runSystemCleanup!(true);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/system/cleanup",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ execute: false })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/system/cleanup",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ execute: true })
      })
    );
  });

  it("reads and saves maintenance settings and validates backups", async () => {
    api.setToken("token value");
    const fetchMock = mockJsonFetch({ autoBackup: { enabled: true, time: "01:20" } });
    const maintenanceApi = api as unknown as {
      getMaintenanceSettings?: () => Promise<unknown>;
      saveMaintenanceSettings?: (input: unknown) => Promise<unknown>;
      validateBackupDirectory?: (path: string) => Promise<unknown>;
    };

    expect(maintenanceApi.getMaintenanceSettings).toBeTypeOf("function");
    expect(maintenanceApi.saveMaintenanceSettings).toBeTypeOf("function");
    expect(maintenanceApi.validateBackupDirectory).toBeTypeOf("function");

    await maintenanceApi.getMaintenanceSettings!();
    await maintenanceApi.saveMaintenanceSettings!({ autoBackup: { enabled: true, time: "01:20" } });
    await maintenanceApi.validateBackupDirectory!("D:\\PDF审批\\backups\\pdf-approval-20260623-010000");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/system/maintenance",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token value" }) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/system/maintenance",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ autoBackup: { enabled: true, time: "01:20" } })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/system/backups/validate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ path: "D:\\PDF审批\\backups\\pdf-approval-20260623-010000" })
      })
    );
  });
});

describe("system update API", () => {
  it("checks update information through the admin endpoint", async () => {
    api.setToken("token value");
    const fetchMock = mockJsonFetch({
      currentVersion: "0.8.0",
      currentApiCompatVersion: 1,
      updateSourceUrl: "http://192.168.1.20/updates/latest.json",
      latest: { version: "0.9.0" },
      updateAvailable: true,
      checkedAt: "2026-06-23T10:00:00.000Z",
      error: null,
      releaseNotes: []
    });
    const updateApi = api as unknown as {
      getSystemUpdateInfo?: () => Promise<unknown>;
    };

    expect(updateApi.getSystemUpdateInfo).toBeTypeOf("function");
    await updateApi.getSystemUpdateInfo!();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/system/update-info",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token value" })
      })
    );
  });

  it("checks client update information through the authenticated user endpoint", async () => {
    api.setToken("token value");
    const fetchMock = mockJsonFetch({
      currentVersion: "0.8.1",
      currentApiCompatVersion: 1,
      updateSourceUrl: "http://192.168.1.20:8080/updates/latest.json",
      latest: {
        version: "0.8.2",
        downloads: { clientInstaller: "http://192.168.1.20:8080/installers/client/PDF图纸审批客户端-安装包-0.8.2.exe" }
      },
      updateAvailable: true,
      checkedAt: "2026-06-23T10:00:00.000Z",
      error: null,
      releaseNotes: []
    });
    const updateApi = api as unknown as {
      getClientUpdateInfo?: () => Promise<unknown>;
    };

    expect(updateApi.getClientUpdateInfo).toBeTypeOf("function");
    await updateApi.getClientUpdateInfo!();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/system/client-update-info",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token value" })
      })
    );
  });

  it("sends the installed desktop client version when checking client updates", async () => {
    api.setToken("token value");
    const fetchMock = mockJsonFetch({
      currentVersion: "0.8.7",
      currentApiCompatVersion: 1,
      updateSourceUrl: "http://192.168.1.20:8080/updates/latest.json",
      latest: {
        version: "0.8.8",
        downloads: { clientInstaller: "http://192.168.1.20:8080/installers/client/PDF图纸审批客户端-安装包-0.8.8.exe" }
      },
      updateAvailable: true,
      checkedAt: "2026-06-25T10:00:00.000Z",
      error: null,
      releaseNotes: []
    });
    const updateApi = api as unknown as {
      getClientUpdateInfo?: (currentVersion?: string | null) => Promise<unknown>;
    };

    expect(updateApi.getClientUpdateInfo).toBeTypeOf("function");
    await updateApi.getClientUpdateInfo!("0.8.7");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/system/client-update-info?currentVersion=0.8.7",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token value" })
      })
    );
  });
});

describe("profile API", () => {
  it("reads and updates the current user's profile", async () => {
    api.setToken("token value");
    const fetchMock = mockJsonFetch({
      user: { id: 1, username: "designer", role: "designer", displayName: "张工" },
      commonProjects: ["项目A"],
      notificationPreferences: { email: { approvalRejected: true } },
      availableNotificationEvents: [{ key: "approvalRejected", label: "图纸被驳回", description: "图纸被主管或工艺驳回" }]
    });

    const profileApi = api as unknown as {
      getProfile?: () => Promise<unknown>;
      updateProfile?: (input: unknown) => Promise<unknown>;
      sendProfileTestEmail?: () => Promise<unknown>;
    };

    expect(profileApi.getProfile).toBeTypeOf("function");
    expect(profileApi.updateProfile).toBeTypeOf("function");
    expect(profileApi.sendProfileTestEmail).toBeTypeOf("function");

    await profileApi.getProfile!();
    await profileApi.updateProfile!({
      displayName: "张工",
      email: "designer@example.com",
      commonProjects: ["项目A"],
      notificationPreferences: { email: { approvalRejected: false } }
    });
    await profileApi.sendProfileTestEmail!();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/profile",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token value" })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/profile",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          displayName: "张工",
          email: "designer@example.com",
          commonProjects: ["项目A"],
          notificationPreferences: { email: { approvalRejected: false } }
        })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/profile/test-email",
      expect.objectContaining({
        method: "POST"
      })
    );
  });
});

describe("designer self-registration API", () => {
  it("registers a designer and stores the returned token", async () => {
    const fetchMock = mockJsonFetch({
      token: "new designer token",
      user: { id: 8, username: "designer01", role: "designer", displayName: "设计一" }
    });

    const user = await api.registerDesigner({
      username: "designer01",
      password: "123456",
      displayName: "设计一",
      email: "designer01@example.com"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/register-designer",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          username: "designer01",
          password: "123456",
          displayName: "设计一",
          email: "designer01@example.com"
        })
      })
    );
    expect(user.role).toBe("designer");
    expect(api.getToken()).toBe("new designer token");
  });
});

describe("password reset API", () => {
  it("requests an email reset link without storing a token", async () => {
    api.setToken("old token");
    const fetchMock = mockJsonFetch({ ok: true });

    await api.requestPasswordReset({ username: "designer01", email: "designer01@example.com" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/password-reset/request",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ username: "designer01", email: "designer01@example.com" })
      })
    );
    expect(api.getToken()).toBe("old token");
  });

  it("confirms a password reset token", async () => {
    const fetchMock = mockJsonFetch({ ok: true });

    await api.confirmPasswordReset({ token: "reset-token", password: "abcdef" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/password-reset/confirm",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "reset-token", password: "abcdef" })
      })
    );
  });
});

describe("signature template API", () => {
  it("lists signature templates scoped by project", async () => {
    api.setToken("token value");
    const fetchMock = mockJsonFetch([]);
    const listSignatureTemplates = (api as unknown as { listSignatureTemplates?: (projectName?: string) => Promise<unknown> })
      .listSignatureTemplates;

    expect(listSignatureTemplates).toBeTypeOf("function");
    await listSignatureTemplates!("项目A");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/signature-templates?projectName=%E9%A1%B9%E7%9B%AEA",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token value"
        })
      })
    );
  });

  it("saves approval placements as a signature template", async () => {
    api.setToken("token value");
    const fetchMock = mockJsonFetch({ id: 9, name: "A3 标准图框" });
    const saveApprovalPlacementsAsTemplate = (
      api as unknown as {
        saveApprovalPlacementsAsTemplate?: (approvalId: number, input: { name: string; projectName?: string }) => Promise<unknown>;
      }
    ).saveApprovalPlacementsAsTemplate;

    expect(saveApprovalPlacementsAsTemplate).toBeTypeOf("function");
    await saveApprovalPlacementsAsTemplate!(4, { name: "A3 标准图框", projectName: "项目A" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/approvals/4/signature-templates",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "A3 标准图框", projectName: "项目A" })
      })
    );
  });
});

describe("submission version trace API", () => {
  it("looks up existing versions by project and part", async () => {
    api.setToken("token value");
    const fetchMock = mockJsonFetch([]);
    const listSubmissionExistingVersions = (
      api as unknown as { listSubmissionExistingVersions?: (projectName: string, partName: string) => Promise<unknown> }
    ).listSubmissionExistingVersions;

    expect(listSubmissionExistingVersions).toBeTypeOf("function");
    await listSubmissionExistingVersions!("项目A", "轴承座");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/submissions/existing-versions?projectName=%E9%A1%B9%E7%9B%AEA&partName=%E8%BD%B4%E6%89%BF%E5%BA%A7",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token value"
        })
      })
    );
  });
});

describe("batch submission API", () => {
  it("uploads batch files through raw PDF upload requests and keeps item-level failures", async () => {
    api.setToken("token value");
    const okUpload: api.SubmissionUploadResult = {
      uploadId: "upload-1",
      originalName: "轴承座-a0A0.pdf",
      parsed: { partName: "轴承座", version: "a0A0", minorVersion: "a0", majorVersion: "A0" },
      existingVersions: []
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => okUpload })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "INVALID_PDF_FILE" }) });
    vi.stubGlobal("fetch", fetchMock);

    const first = new File([new Uint8Array([37, 80, 68, 70, 45])], "轴承座-a0A0.pdf", { type: "application/pdf" });
    const second = new File([new Uint8Array([110, 111, 116])], "错误-a0A0.pdf", { type: "application/pdf" });

    const result = await api.uploadBatchSubmission([first, second], "项目A");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/submissions/upload?fileName=%E8%BD%B4%E6%89%BF%E5%BA%A7-a0A0.pdf&projectName=%E9%A1%B9%E7%9B%AEA",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token value",
          "Content-Type": "application/pdf"
        }),
        body: first
      })
    );
    expect(result.items).toEqual([
      expect.objectContaining({ fileName: "轴承座-a0A0.pdf", status: "uploaded", uploadId: "upload-1" }),
      expect.objectContaining({ fileName: "错误-a0A0.pdf", status: "failed", error: "INVALID_PDF_FILE" })
    ]);
  });

  it("lists batch submission history", async () => {
    api.setToken("token value");
    const fetchMock = mockJsonFetch([]);
    const listBatchSubmissions = (api as unknown as { listBatchSubmissions?: () => Promise<unknown> }).listBatchSubmissions;

    expect(listBatchSubmissions).toBeTypeOf("function");
    await listBatchSubmissions!();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/submissions/batches",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token value"
        })
      })
    );
  });
});

function mockJsonFetch(body: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => body
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
