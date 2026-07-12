import type { Request } from "express";
import ipaddr from "ipaddr.js";
import { HttpProblem } from "../http/problemResponse.ts";

export function clientAddressPrefix(request: Pick<Request, "ip">) {
  const value = request?.ip;
  if (typeof value !== "string" || !ipaddr.isValid(value)) {
    throw new HttpProblem(400, "CLIENT_ADDRESS_INVALID", "Invalid client address");
  }
  let address = ipaddr.parse(value);
  if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()) address = address.toIPv4Address();
  const bytes = address.toByteArray();
  if (address.kind() === "ipv4") {
    bytes[3] = 0;
    return `${ipaddr.fromByteArray(bytes).toString()}/24`;
  }
  for (let index = 8; index < bytes.length; index += 1) bytes[index] = 0;
  return `${ipaddr.fromByteArray(bytes).toString()}/64`;
}
