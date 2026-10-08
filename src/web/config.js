import { BlockList, isIP } from "node:net";

export function loadConfig(env = process.env) {
  if (!env.FOUNDRY_PROJECT_ENDPOINT) throw new Error("Set FOUNDRY_PROJECT_ENDPOINT to your Azure Foundry HTTPS project endpoint.");
  const endpoint = new URL(env.FOUNDRY_PROJECT_ENDPOINT);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash ||
      !/^[a-z0-9-]+\.services\.ai\.azure\.com$/i.test(endpoint.hostname) ||
      !/^\/api\/projects\/[a-zA-Z0-9_-]+\/?$/.test(endpoint.pathname)) {
    throw new Error("FOUNDRY_PROJECT_ENDPOINT must be an Azure Foundry HTTPS project endpoint.");
  }
  const agent = env.FOUNDRY_VOICE_AGENT_NAME || "motivation-coach-agent";
  const version = env.FOUNDRY_VOICE_AGENT_VERSION || "1";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(agent) || !/^[1-9]\d{0,8}$/.test(version)) {
    throw new Error("Invalid fixed agent name/version.");
  }
  const origin = new URL(env.PUBLIC_ORIGIN || "http://localhost:8080");
  if (origin.href !== `${origin.origin}/` ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    throw new Error("PUBLIC_ORIGIN must be one HTTPS origin (HTTP localhost allowed).");
  }
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
  const authMode = env.AZURE_AUTH_MODE || "managed-identity";
  if (!["managed-identity", "azure-cli"].includes(authMode)) throw new Error("Invalid AZURE_AUTH_MODE.");
  if (authMode === "managed-identity" && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(env.AZURE_CLIENT_ID || "")) {
    throw new Error("Set AZURE_CLIENT_ID to the user-assigned managed identity client ID.");
  }
  if (authMode === "azure-cli" && env.NODE_ENV === "production") {
    throw new Error("Production requires managed-identity authentication.");
  }
  const proxies = new BlockList();
  const contentUrl = env.CONTENT_SOURCE_URL || "";
  if (contentUrl) {
    const source = new URL(contentUrl);
    if (source.protocol !== "https:" || source.hostname !== "raw.githubusercontent.com" ||
        source.port || source.username || source.password || source.search || source.hash ||
        !/^\/[^/]+\/[^/]+\/[^/]+\/.+\.json$/.test(source.pathname)) {
      throw new Error("CONTENT_SOURCE_URL must be a raw.githubusercontent.com HTTPS JSON file URL.");
    }
  }
  for (const cidr of (env.TRUSTED_PROXY_CIDRS || "").split(",").filter(Boolean)) {
    const [address, prefix, extra] = cidr.trim().split("/");
    const family = isIP(address);
    const bits = Number(prefix);
    if (!family || extra || prefix === undefined || !Number.isInteger(bits) ||
        bits <= 0 || bits > (family === 4 ? 32 : 128)) throw new Error("Invalid trusted proxy CIDR.");
    proxies.addSubnet(address, bits, family === 4 ? "ipv4" : "ipv6");
  }
  return { endpoint: endpoint.href.replace(/\/$/, ""), agent, version,
    origin: origin.origin, host: origin.host, port, authMode, clientId: env.AZURE_CLIENT_ID, proxies, contentUrl };
}

export function normalizeIp(ip = "") {
  return ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

export function clientIp(req, proxies) {
  let ip = normalizeIp(req.socket.remoteAddress);
  const trusted = (address) => isIP(address) && proxies.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");
  const forwarded = req.headers["x-forwarded-for"];
  if (!trusted(ip) || typeof forwarded !== "string" || forwarded.length > 1024) return ip;
  const chain = forwarded.split(",").map((part) => normalizeIp(part.trim()));
  if (chain.length > 16 || chain.some((part) => !isIP(part))) return ip;
  for (let i = chain.length - 1; i >= 0 && trusted(ip); i--) ip = chain[i];
  return ip;
}
