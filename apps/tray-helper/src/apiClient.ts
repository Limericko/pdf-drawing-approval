import type { TraySummary, TrayUser } from "./types.ts";

export type LoginResponse = {
  token: string;
  user: TrayUser;
};

export type HealthStatus = {
  ok: boolean;
};

export type ApiErrorCode = "auth_expired" | "network_error" | "request_failed";

export class ApiClientError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createApiClient(baseUrl: string, fetchImpl: FetchLike = fetch) {
  const base = normalizeBaseUrl(baseUrl);

  return {
    async login(username: string, password: string) {
      return requestJson<LoginResponse>(fetchImpl, `${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
    },

    async fetchTraySummary(token: string) {
      return requestJson<TraySummary>(fetchImpl, `${base}/api/tray/summary`, {
        headers: { Authorization: `Bearer ${token}` }
      });
    },

    async scanNow(token: string) {
      return requestJson<unknown>(fetchImpl, `${base}/api/system/scan-now`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });
    },

    async restartServer(token: string) {
      return requestJson<unknown>(fetchImpl, `${base}/api/system/restart`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });
    },

    async healthCheck(): Promise<HealthStatus> {
      try {
        const response = await fetchImpl(`${base}/health`);
        return { ok: response.ok };
      } catch {
        return { ok: false };
      }
    }
  };
}

export function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "");
}

async function requestJson<T>(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new ApiClientError("network_error", error instanceof Error ? error.message : "Network request failed");
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new ApiClientError("auth_expired", "Authentication expired");
    }
    throw new ApiClientError("request_failed", `Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}
