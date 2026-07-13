import net from "node:net";

const LOCAL_MAILPIT_PORT = "58025";
const LOCAL_MAILPIT_LOCK_PORT = 58026;
const INVITATION_FRAGMENT = /#\/accept-invitation\?token=([A-Za-z0-9._~-]+)/;

type MailpitAddress = { readonly Address?: string };
type MailpitMessage = { readonly ID?: string; readonly MessageID?: string; readonly To?: readonly MailpitAddress[] };
type MailpitMessageDetail = { readonly Text?: string; readonly HTML?: string };

export function requireLocalMailpitUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("PLATFORM_E2E_MAILPIT_NOT_LOCAL"); }
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.port !== LOCAL_MAILPIT_PORT) {
    throw new Error("PLATFORM_E2E_MAILPIT_NOT_LOCAL");
  }
  return url;
}

export function extractInvitationToken(content: string) {
  const token = content.match(INVITATION_FRAGMENT)?.[1];
  if (!token) throw new Error("PLATFORM_E2E_INVITATION_TOKEN_NOT_FOUND");
  return token;
}

export function createPlatformMailpit(options: { readonly baseUrl: string; readonly fetchImpl?: typeof fetch }) {
  const baseUrl = requireLocalMailpitUrl(options.baseUrl).href.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = async (url: string, init: RequestInit | undefined, code: string) => {
    try { return await fetchImpl(url, init); } catch { throw new Error(code); }
  };
  return Object.freeze({
    async clearLocalTestInstance() {
      const response = await request(`${baseUrl}/api/v1/messages`, { method: "DELETE" },
        "PLATFORM_E2E_MAILPIT_CLEAR_FAILED");
      if (!response.ok) throw new Error("PLATFORM_E2E_MAILPIT_CLEAR_FAILED");
    },
    async waitForInvitation(input: { readonly invitationId: string; readonly recipient: string; readonly timeoutMs?: number }) {
      const expectedMessageId = `invitation-${input.invitationId}@pdf-approval.local`;
      const deadline = Date.now() + (input.timeoutMs ?? 10_000);
      do {
        const listResponse = await request(`${baseUrl}/api/v1/messages`, undefined,
          "PLATFORM_E2E_MAILPIT_QUERY_FAILED");
        if (!listResponse.ok) throw new Error("PLATFORM_E2E_MAILPIT_QUERY_FAILED");
        const list = await listResponse.json() as { readonly messages?: readonly MailpitMessage[] };
        const message = list.messages?.find((candidate) => candidate.MessageID === expectedMessageId &&
          candidate.To?.some(({ Address }) => Address?.toLowerCase() === input.recipient.toLowerCase()));
        if (message?.ID) {
          const detailResponse = await request(`${baseUrl}/api/v1/message/${encodeURIComponent(message.ID)}`, undefined,
            "PLATFORM_E2E_MAILPIT_QUERY_FAILED");
          if (!detailResponse.ok) throw new Error("PLATFORM_E2E_MAILPIT_QUERY_FAILED");
          const detail = await detailResponse.json() as MailpitMessageDetail;
          return { messageId: message.ID,
            invitationToken: extractInvitationToken(`${detail.Text ?? ""}\n${detail.HTML ?? ""}`) };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      throw new Error("PLATFORM_E2E_MAILPIT_MESSAGE_TIMEOUT");
    }
  });
}

export async function acquireLocalMailpitCleanupLock() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => reject(new Error("PLATFORM_E2E_MAILPIT_LOCKED")));
    server.listen({ host: "127.0.0.1", port: LOCAL_MAILPIT_LOCK_PORT, exclusive: true }, () => resolve());
  });
  server.unref();
  let released = false;
  return Object.freeze({
    async release() {
      if (released) return;
      released = true;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}
