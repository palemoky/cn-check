# China Access Check 🧭

检测你的浏览环境是否会被 ChatGPT、Claude、LinkedIn 等网站识别为**中国大陆用户**。

在浏览器中复现这些网站常用的检测手段，逐项打分并给出综合判断，帮助你了解自己的网络环境暴露了哪些信号。托管于 Cloudflare Workers（静态资源 + 边缘 API），无任何数据存储。

## 检测项与权重

| 检测项 | 权重 | 原理 |
|---|---:|---|
| IP 归属地 | 23 | Cloudflare 边缘提供的 IP 地理位置（`request.cf.country`），最直接的信号 |
| 被屏蔽服务可达性 | 18 | 探测 Google (`generate_204`) 是否可达；不可达强烈暗示身处 GFW 之内 |
| 大陆站点延迟 | 13 | 对百度、腾讯、哔哩哔哩 favicon 各采样 3 次取每站最小值，再取三站中**第二低**的值打分（单站可能有海外 CDN 节点，需两站佐证）；< 60ms 说明物理位置在大陆或紧邻 |
| 浏览器时区 | 11 | `Intl.DateTimeFormat().resolvedOptions().timeZone` 为 `Asia/Shanghai` 等 |
| 浏览器语言 | 10 | `navigator.languages` 首选 `zh-CN` / `zh-Hans` |
| 台湾旗帜 Emoji | 8 | 大陆行货或地区设为中国的 Apple 设备会屏蔽 🇹🇼（canvas 对比连字与拆分渲染，用 🇨🇳 做对照）；设备级信号，VPN 无法掩盖 |
| 边缘接入特征 | 7 | Cloudflare 在大陆无公开节点，大陆直连用户到边缘的 TCP RTT（`cf.clientTcpRtt`）通常 > 100ms |
| 时区一致性 | 5 | 浏览器时区与 IP 归属地时区不一致 → 代理迹象；若浏览器时区指向中国则计入中国分 |
| WebRTC 泄露 | 5 | STUN (srflx) 公网地址与 HTTP 出口 IP 不一致 → HTTP 走代理而 UDP 直连 |

每项检测产出 0~1 的置信度，乘以权重后求和，总分 0–100：

- **≥ 60**：很可能被识别为中国大陆用户
- **35–59**：具有较明显的中国大陆特征
- **15–34**：存在少量中国大陆特征
- **< 15**：基本不会被识别

权重与阈值集中在 `public/app.js` 顶部的 `WEIGHTS` / `THRESHOLDS`，可自行调整。

## 架构

```
public/          静态页面（Cloudflare Static Assets 直接托管）
  index.html
  app.js         全部检测与打分逻辑（无依赖的原生 JS）
  style.css
src/index.ts     Worker：仅处理 /api/*
  GET /api/ip    返回 request.cf 中的 IP、国家、ASN、时区、colo、clientTcpRtt 等
  GET /api/ping  204 空响应，供前端测量到 Cloudflare 边缘的往返延迟
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

- **DNS 检测**：浏览器无法直接观察 DNS 解析结果，真正的解析器/污染检测需要一个带通配符解析的自有域名配合日志，v1 未实现（Google 可达性探测已部分覆盖 DNS 污染的效果）。
- **全局代理下的 VPN 用户**：若所有流量都走代理且时区/语言已伪装，则与真实海外用户不可区分——这也是真实网站面临的同样极限。
- **误报来源**：广告拦截插件会拦截对 Google/百度的探测；公司防火墙可能屏蔽 UDP（影响 WebRTC 检测）或大陆站点。

## License

见 [LICENSE](LICENSE)。
