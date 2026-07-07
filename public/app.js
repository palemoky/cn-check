"use strict";

/* ============================================================
 * 配置：权重与阈值
 * 总分 100。每项检测产出 0~1 的置信度，乘以权重后求和。
 * ============================================================ */
const WEIGHTS = {
  ipCountry: 21,   // IP 归属地为中国大陆
  blocked: 16,     // 无法访问 Google 等在大陆被屏蔽的服务
  latency: 12,     // 到大陆站点的延迟显著更低（说明物理位置近）
  timezone: 11,    // 浏览器时区为中国时区
  language: 10,    // 浏览器语言为简体中文
  dnsLeak: 9,      // DNS 解析器出口在中国大陆（分流代理常只代理 HTTP、DNS 仍走国内）
  twFlag: 8,       // 台湾旗帜 emoji 被屏蔽（大陆行货/中国区 Apple 设备，VPN 无法掩盖）
  intlLatency: 6,  // 到美国站点延迟异常偏高而大陆很近（跨境拥堵/GFW 检测开销的典型形态）
  tzMismatch: 3,   // 浏览器时区与 IP 归属地时区不一致（代理迹象）
  webrtc: 4,       // WebRTC 泄露的真实公网 IP 在中国，或与 HTTP 出口不一致
};

// DNS 泄露检测用的委派子域（VPS 上的 dns-probe 对其权威）。
// 前端请求 <uuid>.<该域> 触发解析，解析器出口 IP 由 /api/dns-lookup 回收。
const DNS_PROBE_ZONE = "d.palemoky.com";

const THRESHOLDS = {
  fetchTimeout: 4000,   // 可达性探测超时 (ms)
  latencySamples: 3,    // 每个目标采样次数，取最小值
  latencyNear: 60,      // 低于此值视为“身处大陆或紧邻” (ms)
  latencyMid: 120,
  latencyFar: 200,
  usSlow: 300,          // 到美国的延迟；大陆直连典型 > 300ms，而港/新/日/韩直连多在 150~250ms
  usMid: 200,
};

// 大陆可达、境外访问明显偏慢的站点（favicon 支持 no-cors 拉取）。
// 打分时取“第二低”的站点延迟：单个站点可能有海外 CDN 节点，
// 要求至少两个站点同时低延迟才认为身处大陆附近，降低误判。
const CHINA_ENDPOINTS = [
  { name: "百度", url: "https://www.baidu.com/favicon.ico" },
  { name: "腾讯", url: "https://www.qq.com/favicon.ico" },
  { name: "哔哩哔哩", url: "https://www.bilibili.com/favicon.ico" },
];

// 地理位置固定的国际参照点：AWS S3 区域端点，无全球 CDN、全球可达、大陆未屏蔽，
// 适合用来测“物理线路”而不是“最近的 CDN 节点”
const INTL_ENDPOINTS = [
  { name: "美国东部（弗吉尼亚）", region: "us", url: "https://s3.us-east-1.amazonaws.com/" },
  { name: "美国西部（加州）", region: "us", url: "https://s3.us-west-1.amazonaws.com/" },
  { name: "日本（东京）", region: "asia", url: "https://s3.ap-northeast-1.amazonaws.com/" },
  { name: "新加坡", region: "asia", url: "https://s3.ap-southeast-1.amazonaws.com/" },
];

// 在大陆被屏蔽的服务
const BLOCKED_ENDPOINTS = [
  { name: "Google (gstatic)", url: "https://www.gstatic.com/generate_204" },
  { name: "Google", url: "https://www.google.com/generate_204" },
];

const CHINA_TIMEZONES = ["Asia/Shanghai", "Asia/Urumqi", "Asia/Chongqing", "Asia/Harbin"];
const NEAR_CHINA_TIMEZONES = ["Asia/Hong_Kong", "Asia/Macau"];

/* ============================================================
 * 工具函数
 * ============================================================ */
const $ = (sel) => document.querySelector(sel);

function probe(url, timeout = THRESHOLDS.fetchTimeout) {
  // no-cors 探测：能拿到（不透明）响应说明网络层可达，抛错/超时说明被阻断
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const start = performance.now();
  return fetch(url, { mode: "no-cors", cache: "no-store", signal: ctrl.signal })
    .then(() => ({ ok: true, ms: Math.round(performance.now() - start) }))
    .catch(() => ({ ok: false, ms: Math.round(performance.now() - start) }))
    .finally(() => clearTimeout(timer));
}

async function minLatency(url) {
  let best = Infinity;
  for (let i = 0; i < THRESHOLDS.latencySamples; i++) {
    const r = await probe(`${url}?t=${Date.now()}-${i}`);
    if (r.ok) best = Math.min(best, r.ms);
  }
  return best; // Infinity 表示全部失败
}

function fmtMs(ms) {
  return ms === Infinity ? "不可达" : `${ms} ms`;
}

/* ============================================================
 * 各项检测，每项返回:
 * { confidence: 0~1, summary: 短结论, detail: 说明, flags?: [代理迹象] }
 * ============================================================ */

async function checkIp() {
  const res = await fetch("/api/ip", { cache: "no-store" });
  const info = await res.json();
  const isCN = info.country === "CN";
  const isNear = info.country === "HK" || info.country === "MO";
  return {
    info,
    confidence: isCN ? 1 : isNear ? 0.4 : 0,
    summary: isCN
      ? `中国大陆 (${info.city || info.region || "未知城市"})`
      : `${info.country || "未知"} ${info.city || ""}`.trim(),
    detail:
      `IP: ${info.ip || "未知"}\n` +
      `运营商: AS${info.asn || "?"} ${info.asOrganization || "未知"}\n` +
      `IP 时区: ${info.timezone || "未知"}`,
  };
}

function checkTimezone(ipInfo) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const offset = -new Date().getTimezoneOffset() / 60;
  let confidence = 0;
  if (CHINA_TIMEZONES.includes(tz)) confidence = 1;
  else if (NEAR_CHINA_TIMEZONES.includes(tz)) confidence = 0.4;

  const flags = [];
  let mismatch = 0;
  if (ipInfo?.timezone && tz && ipInfo.timezone !== tz) {
    flags.push(`浏览器时区 (${tz}) 与 IP 归属地时区 (${ipInfo.timezone}) 不一致`);
    // 只有当浏览器时区指向中国时，这种不一致才支持“中国用户在用代理”的判断
    mismatch = confidence >= 1 ? 1 : confidence > 0 ? 0.5 : 0.2;
  }
  return {
    confidence,
    mismatch,
    flags,
    summary: `${tz || "未知"} (UTC${offset >= 0 ? "+" : ""}${offset})`,
    detail: confidence
      ? "浏览器时区指向中国，这是网站识别中国用户最常用的信号之一"
      : "浏览器时区未指向中国",
  };
}

function checkLanguage() {
  const langs = navigator.languages?.length ? [...navigator.languages] : [navigator.language];
  const primary = (langs[0] || "").toLowerCase();
  let confidence = 0;
  if (primary.startsWith("zh-cn") || primary.startsWith("zh-hans")) confidence = 1;
  else if (langs.some((l) => /^zh-(cn|hans)/i.test(l))) confidence = 0.6;
  else if (primary.startsWith("zh")) confidence = 0.2;
  else if (langs.some((l) => /^zh/i.test(l))) confidence = 0.3;
  return {
    confidence,
    summary: langs.slice(0, 3).join(", ") || "未知",
    detail: confidence >= 1
      ? "首选语言为简体中文"
      : confidence > 0
        ? "语言列表中包含中文"
        : "语言列表中不含中文",
  };
}

function checkTwFlag() {
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = size * 2.5;
  canvas.height = size * 1.4;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return { confidence: 0, summary: "无法判断", detail: "Canvas 不可用，无法检测" };
  }
  ctx.font = `${size}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textBaseline = "top";

  const render = (text) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillText(text, 2, 4);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let i = 0; i < d.length; i += 4) {
      const max = Math.max(d[i], d[i + 1], d[i + 2]);
      const min = Math.min(d[i], d[i + 1], d[i + 2]);
      if (d[i + 3] > 128 && max - min > 40) colored++;
    }
    return { sig: canvas.toDataURL(), colored };
  };

  // 旗帜 emoji 由两个区域指示符组成；中间插入零宽空格可阻止其合并。
  // 真正的旗帜需同时满足两个条件：
  // 1. 合成：原样渲染与拆开渲染结果不同（否则只是两个并排的字母）；
  // 2. 彩色：被审查的设备会把 🇹🇼 合成为一个黑白占位框，而非彩色旗帜。
  const probeFlag = (flag) => {
    const pair = render(flag);
    const split = render(flag.slice(0, 2) + "\u200b" + flag.slice(2));
    return { ligates: pair.sig !== split.sig, colorful: pair.colored > 30 };
  };

  const cn = probeFlag("🇨🇳");
  const tw = probeFlag("🇹🇼");

  if (!cn.ligates || !cn.colorful) {
    return {
      confidence: 0,
      summary: "无法判断",
      detail: "系统不渲染彩色旗帜 emoji（常见于 Windows），此项无法用于判断",
    };
  }
  if (!tw.ligates || !tw.colorful) {
    return {
      confidence: 1,
      summary: "🇹🇼 被系统屏蔽",
      flags: ["台湾旗帜 emoji 被屏蔽：设备为大陆行货或地区设为中国大陆，VPN 无法掩盖此特征"],
      detail:
        "🇨🇳 正常渲染为彩色旗帜，🇹🇼 却" +
        (tw.ligates ? "被替换成黑白占位符" : "未合成旗帜") +
        "。\n大陆销售的 Apple 设备或地区设为中国大陆的系统会屏蔽台湾旗帜，" +
        "这是一个与网络无关的设备级信号",
    };
  }
  return {
    confidence: 0,
    summary: "正常渲染",
    detail: "🇹🇼 与 🇨🇳 均正常渲染为彩色旗帜，设备未启用大陆地区的 emoji 屏蔽",
  };
}

async function checkBlocked() {
  // 先确认本站可达（它就是对照组：用户网络本身是通的）
  const results = await Promise.all(BLOCKED_ENDPOINTS.map((e) => probe(e.url)));
  const failed = results.filter((r) => !r.ok).length;
  const confidence = failed === results.length ? 1 : failed > 0 ? 0.5 : 0;
  const lines = BLOCKED_ENDPOINTS.map(
    (e, i) => `${e.name}: ${results[i].ok ? `可达 (${results[i].ms} ms)` : "不可达"}`
  );
  return {
    confidence,
    googleMs: results.find((r) => r.ok)?.ms ?? Infinity,
    summary: failed === results.length ? "Google 不可达" : failed > 0 ? "部分不可达" : "Google 可达",
    detail:
      lines.join("\n") +
      (failed > 0 ? "\n注意：广告拦截插件也可能导致误报" : ""),
  };
}

async function checkLatency() {
  const results = await Promise.all(
    CHINA_ENDPOINTS.map(async (e) => ({ ...e, ms: await minLatency(e.url) }))
  );
  // 取第二低的站点延迟：即使某站的海外 CDN 节点碰巧很快，也需要另一个站佐证
  const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
  const basis = sorted[1];
  let confidence = 0;
  if (basis < THRESHOLDS.latencyNear) confidence = 1;
  else if (basis < THRESHOLDS.latencyMid) confidence = 0.6;
  else if (basis < THRESHOLDS.latencyFar) confidence = 0.2;
  return {
    confidence,
    basis,
    summary: basis === Infinity ? "大陆站点不可达" : `${basis} ms（第二低）`,
    detail:
      results.map((r) => `${r.name}: ${fmtMs(r.ms)}`).join("\n") +
      `\n取第二低值打分（防单站海外 CDN 误判），< ${THRESHOLDS.latencyNear} ms 说明物理位置在大陆或紧邻大陆`,
  };
}

async function checkIntlLatency(latencyPromise) {
  const results = await Promise.all(
    INTL_ENDPOINTS.map(async (e) => ({ ...e, ms: await minLatency(e.url) }))
  );
  const usMin = Math.min(...results.filter((r) => r.region === "us").map((r) => r.ms));
  const asiaMin = Math.min(...results.filter((r) => r.region === "asia").map((r) => r.ms));
  const cnBasis = (await latencyPromise.catch(() => null))?.basis ?? Infinity;

  // 单独看“到美国慢”说明不了什么（可能只是离美国远）；
  // 但“到大陆很近 + 到美国异常慢”是跨境线路（拥堵/加解密/GFW 检测开销）的典型形态
  let confidence = 0;
  if (cnBasis < THRESHOLDS.latencyNear && usMin >= THRESHOLDS.usSlow) confidence = 1;
  else if (cnBasis < THRESHOLDS.latencyNear && usMin >= THRESHOLDS.usMid) confidence = 0.5;
  else if (usMin >= 400 && asiaMin < THRESHOLDS.latencyMid) confidence = 0.3;

  return {
    confidence,
    usMin,
    asiaMin,
    summary:
      usMin === Infinity ? "美国站点不可达" : `美国 ${usMin} ms / 亚太 ${fmtMs(asiaMin)}`,
    detail:
      results.map((r) => `${r.name}: ${fmtMs(r.ms)}`).join("\n") +
      "\n参照点为 AWS 区域端点（位置固定、无全球 CDN）。大陆直连美国通常 > 300 ms，" +
      "而港/新/日/韩等地直连美国多在 150~250 ms",
  };
}

// 收集 WebRTC STUN (srflx) 暴露的公网候选地址
function gatherStunIps() {
  return new Promise((resolve) => {
    let pc;
    try {
      pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      });
    } catch {
      resolve(null); // 不支持 WebRTC
      return;
    }
    const ips = new Set();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pc.close();
      resolve([...ips]);
    };
    const timer = setTimeout(finish, 5000);
    pc.createDataChannel("probe");
    pc.onicecandidate = (e) => {
      if (!e.candidate) return finish();
      // candidate 格式: foundation component protocol priority address port typ type ...
      const parts = e.candidate.candidate.split(" ");
      const typIdx = parts.indexOf("typ");
      // 排除 mDNS 混淆地址（.local）与私网地址
      if (typIdx > 0 && parts[typIdx + 1] === "srflx" && !parts[4].endsWith(".local"))
        ips.add(parts[4]);
    };
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(finish);
  });
}

async function checkWebRTC(ipInfo) {
  const leaked = await gatherStunIps();
  if (leaked === null) {
    return { confidence: 0, summary: "不支持", detail: "浏览器不支持 WebRTC 或已被禁用" };
  }
  if (leaked.length === 0) {
    return {
      confidence: 0,
      summary: "无公网候选",
      detail: "未获取到 STUN 公网地址（UDP 被阻断或浏览器已保护），无法比对",
    };
  }

  const httpIp = ipInfo?.ip || "";
  // 只对 IPv4 做 chnroutes 归属判断
  const v4 = leaked.filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  const chinaChecks = await Promise.all(
    v4.map((ip) =>
      fetch(`/api/ip-china?ip=${encodeURIComponent(ip)}`)
        .then((r) => r.json())
        .then((j) => ({ ip, china: !!j.china }))
        .catch(() => ({ ip, china: false }))
    )
  );
  const chinaLeak = chinaChecks.find((c) => c.china);

  if (chinaLeak) {
    // 最强信号：无论 HTTP 出口在哪，WebRTC 暴露的真实公网 IP 落在中国大陆
    return {
      confidence: 1,
      chinaLeak: true,
      flags: [`WebRTC 泄露的真实公网 IP (${chinaLeak.ip}) 属于中国大陆`],
      summary: "真实 IP 在中国大陆",
      detail:
        `STUN 公网地址: ${leaked.join(", ")}\n` +
        `其中 ${chinaLeak.ip} 经 chnroutes 判定属于中国大陆。\n` +
        "即使 HTTP 走了代理，UDP 直连仍暴露了位于中国的真实网络",
    };
  }
  if (leaked.includes(httpIp)) {
    return {
      confidence: 0,
      summary: "与 HTTP IP 一致",
      detail: `STUN 公网地址: ${leaked.join(", ")}\n与 HTTP 出口一致，无代理泄露`,
    };
  }
  const sameFamily = leaked.filter((ip) => ip.includes(":") === httpIp.includes(":"));
  if (sameFamily.length > 0) {
    return {
      confidence: 1, // 仅代理迹象，是否计入中国分在汇总处受其他信号约束
      flags: ["WebRTC 泄露的公网 IP 与 HTTP 出口不一致"],
      summary: "泄露了不同的公网 IP",
      detail:
        `STUN 公网地址: ${leaked.join(", ")}\nHTTP 出口: ${httpIp}\n` +
        "两者不一致，说明 HTTP 流量走了代理，而 UDP 直连暴露了另一网络（但不在中国大陆）",
    };
  }
  return {
    confidence: 0,
    summary: "IP 协议族不同",
    detail: `STUN 地址 (${leaked.join(", ")}) 与 HTTP 出口 (${httpIp}) 协议族不同，无法直接比对`,
  };
}

async function checkDnsLeak() {
  const uuid = (crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^a-z0-9-]/gi, "");
  // 1. 请求 <uuid>.<zone> 触发浏览器所用递归解析器去查询 VPS 权威服务器。
  //    连接本身成功与否无所谓——DNS 解析在建立连接前就已发生。
  await fetch(`https://${uuid}.${DNS_PROBE_ZONE}/`, { mode: "no-cors", cache: "no-store" })
    .catch(() => {});
  // 2. 给解析器留一点落库时间，再经本站 Worker 代理回收解析器出口 IP
  await new Promise((r) => setTimeout(r, 1500));
  let data;
  try {
    const res = await fetch(`/api/dns-lookup?id=${uuid}`, { cache: "no-store" });
    data = await res.json();
  } catch (e) {
    return { confidence: 0, summary: "无法判断", detail: "查询 DNS 探测服务失败：" + e };
  }

  if (data.available === false) {
    return {
      confidence: 0,
      summary: "探测服务不可用",
      detail: "DNS 泄露探测服务（VPS）未部署或不可达，此项跳过",
    };
  }
  const resolvers = data.resolvers || [];
  if (resolvers.length === 0) {
    return {
      confidence: 0,
      summary: "未捕获解析器",
      detail:
        "未能在时限内观测到你的解析器查询——可能是 DNS 委派未生效、解析被缓存，或浏览器未真正发起解析",
    };
  }
  const chinaOne = resolvers.find((r) => r.china);
  const list = resolvers.map((r) => `${r.ip}${r.china ? "（中国大陆）" : ""}`).join("\n");
  if (chinaOne) {
    return {
      confidence: 1,
      chinaDns: true,
      flags: [`DNS 解析器出口 (${chinaOne.ip}) 在中国大陆`],
      summary: "解析器在中国大陆",
      detail:
        `观测到的解析器出口:\n${list}\n` +
        "DNS 解析走了中国大陆的解析器——分流代理常只代理 HTTP、DNS 仍用国内运营商，这是很强的中国特征",
    };
  }
  return {
    confidence: 0,
    summary: "解析器在境外",
    detail: `观测到的解析器出口:\n${list}\n均不在中国大陆`,
  };
}

/* ============================================================
 * 汇总打分与渲染
 * ============================================================ */

const CHECK_DEFS = [
  { key: "ipCountry", icon: "🌐", name: "IP 归属地" },
  { key: "blocked", icon: "🚧", name: "被屏蔽服务可达性" },
  { key: "latency", icon: "⚡", name: "大陆站点延迟" },
  { key: "timezone", icon: "🕐", name: "浏览器时区" },
  { key: "language", icon: "🀄️", name: "浏览器语言" },
  { key: "dnsLeak", icon: "🔀", name: "DNS 解析器归属" },
  { key: "twFlag", icon: "🏳️", name: "台湾旗帜 Emoji" },
  { key: "intlLatency", icon: "🌍", name: "国际站点延迟" },
  { key: "tzMismatch", icon: "🎭", name: "时区一致性" },
  { key: "webrtc", icon: "🔓", name: "WebRTC 泄露" },
];

function renderCards() {
  const grid = $("#checks");
  grid.innerHTML = "";
  for (const def of CHECK_DEFS) {
    const card = document.createElement("div");
    card.className = "card pending";
    card.id = `check-${def.key}`;
    card.innerHTML = `
      <div class="card-head">
        <span class="card-icon">${def.icon}</span>
        <span class="card-name">${def.name}</span>
        <span class="card-score" title="得分 / 权重">– / ${WEIGHTS[def.key]}</span>
      </div>
      <div class="card-summary">检测中…</div>
      <pre class="card-detail"></pre>`;
    grid.appendChild(card);
  }
}

function fillCard(key, result, score) {
  const card = $(`#check-${key}`);
  if (!card) return;
  card.classList.remove("pending");
  card.classList.add(score >= WEIGHTS[key] * 0.8 ? "hit" : score > 0 ? "partial" : "miss");
  // 部分命中会产生小数（如置信度 0.4 × 权重 23 = 9.2），整数时不显示 .0
  card.querySelector(".card-score").textContent = `${+score.toFixed(1)} / ${WEIGHTS[key]}`;
  card.querySelector(".card-summary").textContent = result.summary;
  card.querySelector(".card-detail").textContent = result.detail || "";
}

function failCard(key, err) {
  const card = $(`#check-${key}`);
  if (!card) return;
  card.classList.remove("pending");
  card.classList.add("miss");
  card.querySelector(".card-score").textContent = `0 / ${WEIGHTS[key]}`;
  card.querySelector(".card-summary").textContent = "检测失败";
  card.querySelector(".card-detail").textContent = String(err);
}

function verdict(score) {
  if (score >= 60) return ["很可能被识别为中国大陆用户", "high"];
  if (score >= 35) return ["具有较明显的中国大陆特征", "mid"];
  if (score >= 15) return ["存在少量中国大陆特征", "low"];
  return ["基本不会被识别为中国大陆用户", "none"];
}

function renderScore(total, flags, analysis) {
  const [text, level] = verdict(total);
  $("#score-num").textContent = Math.round(total);
  $("#score-verdict").textContent = text;
  const bar = $("#score-bar-fill");
  bar.style.width = `${Math.min(100, total)}%`;
  $("#score").dataset.level = level;

  const analysisEl = $("#analysis");
  if (analysis?.length) {
    analysisEl.hidden = false;
    analysisEl.innerHTML =
      "<strong>综合研判（信号交叉比对，额外计分）：</strong>" +
      analysis
        .map((a) => `<div class="analysis-item">🔍 ${a.text}（+${a.bonus} 分）</div>`)
        .join("");
  } else {
    analysisEl.hidden = true;
  }

  const flagsEl = $("#flags");
  if (flags.length) {
    flagsEl.hidden = false;
    flagsEl.innerHTML =
      "<strong>代理 / VPN 迹象：</strong>" +
      flags.map((f) => `<div class="flag">⚠️ ${f}</div>`).join("");
  } else {
    flagsEl.hidden = true;
  }
}

async function runAll() {
  $("#rerun").disabled = true;
  $("#score-num").textContent = "…";
  $("#score-verdict").textContent = "检测中，约需 10 秒";
  $("#flags").hidden = true;
  $("#analysis").hidden = true;
  renderCards();

  const scores = {};
  const allFlags = [];
  const record = (key, result) => {
    const score = (result.confidence || 0) * WEIGHTS[key];
    scores[key] = score;
    if (result.flags) allFlags.push(...result.flags);
    fillCard(key, result, score);
    return result;
  };

  // IP 信息是其它几项的依赖，先取
  let ipInfo = null;
  try {
    const r = await checkIp();
    ipInfo = r.info;
    record("ipCountry", r);
  } catch (e) {
    failCard("ipCountry", e);
    scores.ipCountry = 0;
  }

  // 时区（同步，顺带产出“时区不一致”这一项）
  let tzChina = false;
  let langChina = false;
  try {
    const tz = checkTimezone(ipInfo);
    tzChina = tz.confidence >= 1;
    record("timezone", tz);
    record("tzMismatch", {
      confidence: tz.mismatch || 0,
      flags: [],
      summary: tz.mismatch ? "不一致" : "一致",
      detail: tz.mismatch
        ? "浏览器时区与 IP 归属地不匹配，常见于使用代理/VPN 的场景"
        : "浏览器时区与 IP 归属地相符",
    });
  } catch (e) {
    failCard("timezone", e);
    failCard("tzMismatch", e);
  }

  try {
    const lang = checkLanguage();
    langChina = lang.confidence >= 1;
    record("language", lang);
  } catch (e) {
    failCard("language", e);
  }

  let twCensored = false;
  try {
    const tw = checkTwFlag();
    twCensored = tw.confidence >= 1;
    record("twFlag", tw);
  } catch (e) {
    failCard("twFlag", e);
  }

  // 网络探测并行跑；国际延迟检测依赖大陆延迟的结果，共享同一个 promise
  const latencyPromise = checkLatency();
  const [blocked, latency, intl, webrtc, dns] = await Promise.all([
    checkBlocked().catch((e) => (failCard("blocked", e), null)),
    latencyPromise.catch((e) => (failCard("latency", e), null)),
    checkIntlLatency(latencyPromise).catch((e) => (failCard("intlLatency", e), null)),
    checkWebRTC(ipInfo).catch((e) => (failCard("webrtc", e), null)),
    checkDnsLeak().catch((e) => (failCard("dnsLeak", e), null)),
  ]);

  if (blocked) record("blocked", blocked);
  if (latency) record("latency", latency);
  if (intl) record("intlLatency", intl);
  if (dns) record("dnsLeak", dns);
  if (webrtc) {
    // 泄露 IP 在中国 → 直接计分；仅“与 HTTP 出口不一致”的代理迹象则需其他中国信号佐证
    if (webrtc.confidence > 0 && !webrtc.chinaLeak && !tzChina && !langChina)
      webrtc.confidence = 0;
    record("webrtc", webrtc);
  }

  // ---- 综合研判：交叉比对各信号的一致性 ----
  // 单项检测各自打分，但“信号之间的矛盾”本身是更强的证据：
  // 例如 IP 在境外，物理延迟却表明身在大陆 → 分流代理的典型形态。
  const analysis = [];
  const cnBasis = latency?.basis ?? Infinity;
  const usMin = intl?.usMin ?? Infinity;
  const notCN = !!ipInfo?.country && ipInfo.country !== "CN";

  if (notCN && cnBasis < THRESHOLDS.latencyNear && usMin >= THRESHOLDS.usSlow) {
    analysis.push({
      bonus: 12,
      text:
        `IP 归属地是 ${ipInfo.country}，但到大陆站点仅 ${cnBasis} ms、到美国站点却要 ${usMin} ms：` +
        "物理位置高度疑似大陆，IP 更像是分流代理的出口",
    });
  }
  if (notCN && twCensored) {
    analysis.push({
      bonus: 8,
      text: "设备为大陆行货或中国区系统（🇹🇼 被屏蔽），IP 却在境外：疑似使用代理的中国用户",
    });
  }
  if (notCN && dns?.chinaDns) {
    analysis.push({
      bonus: 8,
      text: "DNS 解析器出口在中国大陆，IP 却在境外：典型的分流代理（只代理 HTTP、DNS 走国内）",
    });
  }
  // 注：「时区为中国 + IP 在境外」的矛盾已由 tzMismatch 权重项计分，不在此重复加分

  const bonus = analysis.reduce((sum, a) => sum + a.bonus, 0);
  const base = Object.values(scores).reduce((a, b) => a + b, 0);
  const total = Math.min(100, base + bonus);
  renderScore(total, allFlags, analysis);
  $("#rerun").disabled = false;
}

document.addEventListener("DOMContentLoaded", () => {
  $("#rerun").addEventListener("click", runAll);
  runAll();
});
