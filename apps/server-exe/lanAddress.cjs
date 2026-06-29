const os = require("node:os");

function createLanUrl(port, interfaces = os.networkInterfaces()) {
  const address = chooseLanIPv4Address(interfaces);
  return address ? `http://${address}:${port}` : "";
}

function chooseLanIPv4Address(interfaces = os.networkInterfaces()) {
  const candidates = [];
  for (const [interfaceName, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      if (!isUsableLanIPv4(interfaceName, entry)) continue;
      candidates.push({
        address: entry.address,
        interfaceName,
        score: scoreLanCandidate(interfaceName, entry)
      });
    }
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.interfaceName.localeCompare(right.interfaceName, "zh-CN");
  });

  return candidates[0]?.address ?? "";
}

function isUsableLanIPv4(interfaceName, entry) {
  if (!entry || !isIPv4Family(entry.family)) return false;
  if (entry.internal || !entry.address) return false;
  if (isVirtualInterfaceName(interfaceName)) return false;
  if (isLoopbackIPv4(entry.address) || isLinkLocalIPv4(entry.address) || isUnspecifiedIPv4(entry.address)) return false;
  if (entry.netmask === "255.255.255.255" || String(entry.cidr || "").endsWith("/32")) return false;
  if (isZeroMac(entry.mac)) return false;
  return true;
}

function scoreLanCandidate(interfaceName, entry) {
  let score = 0;
  const name = String(interfaceName || "").toLowerCase();

  if (isPrivateIPv4(entry.address)) score += 100;
  if (entry.address.startsWith("192.168.")) score += 20;
  if (entry.address.startsWith("10.")) score += 15;
  if (isPrivate172IPv4(entry.address)) score += 10;
  if (/^(ethernet|wi-?fi|wlan|lan|以太网|无线|本地连接)/i.test(interfaceName || "")) score += 30;
  if (name.includes("bluetooth")) score -= 20;

  const prefixLength = parsePrefixLength(entry.cidr);
  if (prefixLength && prefixLength >= 16 && prefixLength <= 30) score += 8;

  return score;
}

function isIPv4Family(family) {
  return family === "IPv4" || family === 4;
}

function isVirtualInterfaceName(interfaceName) {
  const name = String(interfaceName || "").toLowerCase();
  return [
    "tap",
    "tun",
    "tunnel",
    "wintun",
    "wireguard",
    "tailscale",
    "zerotier",
    "openvpn",
    "vpn",
    "clash",
    "cfw",
    "vgate",
    "vmware",
    "virtualbox",
    "vbox",
    "virtual",
    "hyper-v",
    "vethernet",
    "docker",
    "wsl",
    "loopback",
    "isatap",
    "teredo"
  ].some((keyword) => name.includes(keyword));
}

function isZeroMac(mac) {
  const normalized = String(mac || "").replace(/[:-]/g, "").toLowerCase();
  return normalized === "" || /^0+$/.test(normalized);
}

function isLoopbackIPv4(address) {
  return address.startsWith("127.");
}

function isLinkLocalIPv4(address) {
  return address.startsWith("169.254.");
}

function isUnspecifiedIPv4(address) {
  return address === "0.0.0.0" || address === "255.255.255.255";
}

function isPrivateIPv4(address) {
  return address.startsWith("10.") || address.startsWith("192.168.") || isPrivate172IPv4(address);
}

function isPrivate172IPv4(address) {
  const parts = address.split(".");
  const second = Number(parts[1]);
  return parts[0] === "172" && second >= 16 && second <= 31;
}

function parsePrefixLength(cidr) {
  const match = /\/(\d+)$/.exec(String(cidr || ""));
  if (!match) return 0;
  return Number(match[1]);
}

module.exports = {
  chooseLanIPv4Address,
  createLanUrl
};
