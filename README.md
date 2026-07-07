# China Access Check

检测你的浏览环境是否会被 ChatGPT、Claude、LinkedIn 等网站识别为**中国大陆用户**。

在浏览器中复现这些网站常用的检测手段，逐项打分并给出综合判断，帮助你了解自己的网络环境暴露了哪些信号。托管于 Cloudflare Workers（静态资源 + 边缘 API），无任何数据存储。

## 检测项与权重


无法隐藏的项目：
- 台湾 emoji 被屏蔽
- 大陆主流站点稳定低延迟，且美国主流站点不可访问或稳定高延迟

难以隐藏的项目：
- 非东八区
- 系统无简体中文字体


| 检测项 | 权重 | 原理 |
|---|---:|---|
| IP 归属地 | 21 | Cloudflare 边缘提供的 IP 地理位置（`request.cf.country`），并用 chnroutes CIDR 独立核对；最直接的信号 |
| 被屏蔽服务可达性 | 16 | 探测 Google (`generate_204`) 是否可达；不可达强烈暗示身处 GFW 之内 |
| 大陆站点延迟 | 12 | 对百度、腾讯、哔哩哔哩 favicon 各采样 3 次取每站最小值，再取三站中**第二低**的值打分（单站可能有海外 CDN 节点，需两站佐证）；< 60ms 说明物理位置在大陆或紧邻 |
| 浏览器时区 | 11 | `Intl.DateTimeFormat().resolvedOptions().timeZone` 为 `Asia/Shanghai` 等 |
| 浏览器语言 | 10 | `navigator.languages` 首选 `zh-CN` / `zh-Hans` |
| DNS 解析器归属 | 9 | 前端触发 `<uuid>.d.palemoky.com` 解析，VPS 上的 dns-probe 记录解析器出口 IP，Worker 代理回收并 chnroutes 判定；解析器在大陆而 HTTP 在境外 = 分流代理特征。需部署 `dns-probe/`，未部署则此项跳过不计分 |
| 台湾旗帜 Emoji | 8 | 大陆行货或地区设为中国的 Apple 设备会屏蔽 🇹🇼（canvas 对比连字与拆分渲染 + 彩色像素判定，用 🇨🇳 做对照）；设备级信号，VPN 无法掩盖 |
| 国际站点延迟 | 6 | 以 AWS 美东/美西/东京/新加坡区域端点为参照（位置固定、无全球 CDN）；「大陆很近 + 美国异常慢（>300ms）」是跨境线路拥堵/GFW 开销的典型形态，港/新/日/韩直连美国多在 150~250ms |
| 时区一致性 | 3 | 浏览器时区与 IP 归属地时区不一致 → 代理迹象；若浏览器时区指向中国则计入中国分 |
| WebRTC 泄露 | 4 | STUN (srflx) 暴露的真实公网 IP 经 chnroutes 判定在中国大陆（最强），或与 HTTP 出口不一致（仅代理迹象） |

每项检测产出 0~1 的置信度，乘以权重后求和得到基础分。在此之上还有**综合研判**层：交叉比对信号之间的一致性，发现矛盾时额外加分（封顶 100）——

- IP 在境外，但到大陆站点 < 60ms 且到美国站点 > 300ms → +12（物理位置高度疑似大陆，IP 是分流代理出口）
- 设备为大陆行货/中国区（🇹🇼 被屏蔽），IP 却在境外 → +8（疑似使用代理的中国用户）
- DNS 解析器出口在大陆，IP 却在境外 → +8（分流代理：只代理 HTTP、DNS 走国内）

总分 0–100：

- **≥ 60**：很可能被识别为中国大陆用户
- **35–59**：具有较明显的中国大陆特征
- **15–34**：存在少量中国大陆特征
- **< 15**：基本不会被识别

权重与阈值集中在 `public/app.js` 顶部的 `WEIGHTS` / `THRESHOLDS`，可自行调整。

## 架构

```
public/               静态页面（Cloudflare Static Assets 直接托管）
  index.html
  app.js              全部检测与打分逻辑（无依赖的原生 JS）
  style.css
src/index.ts          Worker：仅处理 /api/*
  GET /api/ip         返回 request.cf 中的 IP、国家、ASN、时区、colo，并附 chnroutes 判定
  GET /api/ip-china   判断任意 IPv4 是否属于中国大陆（供 WebRTC 泄露比对）
  GET /api/dns-lookup 服务端代理 VPS 的 dns-probe，回收解析器出口 IP 并 chnroutes 判定
src/chnroutes.ts      IPv4 是否在中国大陆的二分查找
src/chnroutes-data.ts 自动生成的 CIDR 区间数据（勿手改）
scripts/build-chnroutes.mjs  刷新 chnroutes 数据：node scripts/build-chnroutes.mjs
.github/workflows/update-chnroutes.yml  每日定时重建 chnroutes，有变化才提交（触发自动部署）
dns-probe/            可选：部署在自有 VPS 上的 DNS 泄露探测服务（见其 README）
```

`wrangler.jsonc` 中 `run_worker_first: ["/api/*"]`——静态资源不经过 Worker，不产生请求费用。

## 开发与部署

```bash
npm install
npm run dev      # 本地开发 (http://localhost:8787)
npm run deploy   # 部署到 Cloudflare
```

首次部署需 `npx wrangler login`。部署后可在 Cloudflare Dashboard 绑定自定义域名。

## 已知局限

- **DNS 解析器检测依赖 VPS**：该项需要一台自有 VPS 部署 `dns-probe/` 作权威 DNS 观测解析器出口。前端与 Worker 代理（`/api/dns-lookup`）已合入主站；VPS 未部署或不可达时此项自动跳过、不计分，不影响其它检测。
- **全局代理下的 VPN 用户**：若所有流量都走代理且时区/语言已伪装，则与真实海外用户不可区分——这也是真实网站面临的同样极限。
- **误报来源**：广告拦截插件会拦截对 Google/百度的探测；公司防火墙可能屏蔽 UDP（影响 WebRTC 检测）或大陆站点。

## License

见 [LICENSE](LICENSE)。
