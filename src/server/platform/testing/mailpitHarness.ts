type MailpitAddress = { readonly Address?: string };
type MailpitMessage = {
  readonly ID?: string;
  readonly MessageID?: string;
  readonly To?: readonly MailpitAddress[];
  readonly Subject?: string;
};

export function createMailpitHarness(options: { readonly baseUrl: string }) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return Object.freeze({
    async clear() {
      const response = await fetch(`${baseUrl}/api/v1/messages`, { method: "DELETE" });
      if (!response.ok) throw new Error("MAILPIT_CLEAR_FAILED");
    },
    async findByMessageIdAndRecipient(messageId: string, recipient: string) {
      const response = await fetch(`${baseUrl}/api/v1/messages`);
      if (!response.ok) throw new Error("MAILPIT_QUERY_FAILED");
      const payload = await response.json() as { messages?: MailpitMessage[] };
      const canonicalId = messageId.replace(/^<|>$/g, "");
      return payload.messages?.find((message) => message.MessageID === canonicalId &&
        message.To?.some((address) => address.Address?.toLowerCase() === recipient.toLowerCase()));
    },
    async countByMessageIdAndRecipient(messageId: string, recipient: string) {
      const response = await fetch(`${baseUrl}/api/v1/messages`);
      if (!response.ok) throw new Error("MAILPIT_QUERY_FAILED");
      const payload = await response.json() as { messages?: MailpitMessage[] };
      const canonicalId = messageId.replace(/^<|>$/g, "");
      return payload.messages?.filter((message) => message.MessageID === canonicalId &&
        message.To?.some((address) => address.Address?.toLowerCase() === recipient.toLowerCase())).length ?? 0;
    }
  });
}
