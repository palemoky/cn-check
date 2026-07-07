import { isChinaIP } from "./chnroutes";

export interface Env {
  ASSETS: Fetcher;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

// DNS 泄露探测服务（部署在 VPS 上，见 dns-probe/）的 lookup 接口。
// 由 Worker 服务端代理，浏览器只与本站 HTTPS 通信，规避混合内容与跨域问题。
const DNS_PROBE_LOOKUP = "http://ns-probe.palemoky.com/lookup";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/api/ip":
        return handleIp(request);
      case "/api/ip-china":
        // 判断任意 IPv4 是否属于中国大陆（供 WebRTC 泄露检测比对泄露的公网 IP）
        return handleIpChina(url);
      case "/api/dns-lookup":
        // 服务端代理 VPS 上的 DNS 泄露探测服务，返回该 uuid 对应的解析器出口 IP
        return handleDnsLookup(url);
      default:
        // run_worker_first 只匹配 /api/*，走到这里说明是未知的 API 路径
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: JSON_HEADERS,
        });
    }
  },
} satisfies ExportedHandler<Env>;

function handleIp(request: Request): Response {
  const cf = (request.cf ?? {}) as IncomingRequestCfProperties;
  const ip = request.headers.get("cf-connecting-ip");

  const body = {
    ip,
    country: cf.country ?? null,
    region: cf.region ?? null,
    city: cf.city ?? null,
    timezone: cf.timezone ?? null,
    asn: cf.asn ?? null,
    asOrganization: cf.asOrganization ?? null,
    // 处理本次请求的 Cloudflare 数据中心（IATA 代码）。
    // Cloudflare 在中国大陆无公开节点，大陆直连用户通常落在 HKG/SJC/LAX/NRT 等境外节点。
    colo: cf.colo ?? null,
    httpProtocol: cf.httpProtocol ?? null,
    acceptLanguage: request.headers.get("accept-language"),
    // 用 chnroutes 独立核对 HTTP 出口 IP 是否在大陆（与 cf.country 互为佐证）
    ipInChina: ip ? isChinaIP(ip) : null,
  };

  return new Response(JSON.stringify(body), { headers: JSON_HEADERS });
}

function handleIpChina(url: URL): Response {
  const ip = url.searchParams.get("ip") ?? "";
  return new Response(JSON.stringify({ ip, china: isChinaIP(ip) }), {
    headers: JSON_HEADERS,
  });
}

async function handleDnsLookup(url: URL): Promise<Response> {
  const id = url.searchParams.get("id") ?? "";
  // 仅允许简单 id（uuid 形态），避免被用作开放代理
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) {
    return new Response(JSON.stringify({ error: "bad id" }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }
  try {
    const upstream = await fetch(`${DNS_PROBE_LOOKUP}?id=${id}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    const data = (await upstream.json()) as { resolvers?: string[] };
    // 顺带给出每个解析器是否在中国大陆，前端免去逐个再查
    const resolvers = (data.resolvers ?? []).map((ip) => ({
      ip,
      china: isChinaIP(ip),
    }));
    return new Response(JSON.stringify({ id, resolvers }), {
      headers: JSON_HEADERS,
    });
  } catch (e) {
    // 探测服务未部署 / 不可达：返回可用状态，前端据此判定为“无法判断”
    return new Response(
      JSON.stringify({ id, resolvers: [], available: false, error: String(e) }),
      { headers: JSON_HEADERS }
    );
  }
}
