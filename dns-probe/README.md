# DNS 泄露探测服务（部署在你的美国 VPS）

一个极简权威 DNS 服务器 + 查询 API，用来检测**用户的 DNS 解析器出口是否在中国大陆**。

## 为什么需要一台 VPS

要知道「哪个解析器来查询了域名」，只能在**权威 DNS 服务器**上观测——托管在 Cloudflare 的 DNS 不暴露这个信息，Cloudflare Worker 也无法监听 UDP 53。所以需要一台有公网 IP 的机器。

## 原理

```
浏览器                             用户的递归解析器           本服务
  │  请求 <uuid>.d.example.com          │                    │
  │───────────────────────────────────▶│                    │
  │                                    │   查 A 记录         │
  │                                    │───────────────────▶│  记录：uuid → 解析器出口IP
  │                                    │◀───────────────────│  返回 A = VPS IP
  │  再调用 GET /lookup?id=<uuid> ──────────────────────────▶│  返回解析器出口IP
  │                                                         │
  ▼
把解析器出口IP 交给主站 /api/ip-china 判断是否在中国大陆
```

**关键洞察**：浏览器发起的是 HTTP（可能走代理），但域名解析由系统的**递归解析器**完成。分流代理（如 Clash 规则模式）常只代理 HTTP 流量、DNS 仍用本地运营商解析器——于是「HTTP 出口在境外，DNS 解析器出口在中国大陆」，这是很强的中国用户特征。

## 部署步骤

### 1. DNS 委派（在 example.com 的 DNS 托管商处配置）

假设用子域 `d.example.com`，VPS 公网 IP 记为 `203.0.113.10`：

```
; 把 d.example.com 这个子域委派给你的 VPS 作权威服务器
ns-probe.example.com.   A     203.0.113.10
d.example.com.          NS    ns-probe.example.com.
```

> 注意：以上 A 和 NS 记录若托管在 Cloudflare，需保证该子域为 **DNS only**（灰云），不要开代理。

### 2. 在 VPS 上放行端口

```bash
sudo ufw allow 53/udp     # DNS
sudo ufw allow 8653/tcp   # 查询 API（建议前面再挂 Nginx/Caddy 上 HTTPS）
```

### 3. 用 Docker 运行（拉取预构建镜像）

镜像由 GitHub Actions 自动构建并推送到 GHCR（`ghcr.io/<你的用户名>/dns-probe`，见 `.github/workflows/build-dns-probe.yml`，同时构建 amd64/arm64）。**服务器无需装 Go、也不在本地构建**，只需拉取镜像启动。

```bash
git clone <本仓库> && cd china-access-check/dns-probe

# 填写你的委派子域与 VPS 公网 IP
cp .env.example .env
vi .env        # PROBE_ZONE=dns-probe.example.com  PROBE_ANSWER=203.0.113.10

# 若 GHCR 包设为私有，先登录（公开则跳过）：
#   echo <GitHub PAT，勾选 read:packages> | docker login ghcr.io -u <用户名> --password-stdin

docker compose up -d       # pull_policy: always 会自动拉最新镜像
docker compose logs -f     # 查看查询日志
```

`docker-compose.yml` 已把 DNS 端口 `53/udp` 对外开放，查询 API `8653` 只绑 `127.0.0.1`（由第 4 步的 HTTPS 反代对外暴露）。

> **注意**：若宿主机本身跑着 systemd-resolved 占用 53 端口，需先释放——
> 编辑 `/etc/systemd/resolved.conf` 设 `DNSStubListener=no` 后 `systemctl restart systemd-resolved`。

验证（从任意机器）：

```bash
dig @203.0.113.10 abc123.dns-probe.example.com A +short   # 应返回 203.0.113.10
curl "http://127.0.0.1:8653/lookup?id=abc123"               # 在 VPS 上执行，应看到解析器出口 IP
```

更新到新镜像 / 常用运维：

```bash
docker compose pull && docker compose up -d   # 拉取并滚动到最新镜像
docker compose restart                        # 重启
docker compose down                           # 停止并移除
```

`restart: unless-stopped` 已保证开机自启与崩溃自动重启，无需额外的 systemd 单元。

> 每次改动 `dns-probe/` 并推送到 `main`，Actions 会自动重建镜像；服务器执行 `docker compose pull && docker compose up -d` 即可更新。

### 4. 暴露查询 API（HTTP 即可，无需 HTTPS）

查询 API 由主站的 Cloudflare Worker **服务端**代理（见下方「前端接入」），浏览器不直接访问它，因此**只需 HTTP:80**，不必在 VPS 上解决 HTTPS/证书/443 端口问题。

只要让 traefik（或任意反代）把 `ns-probe.palemoky.com` 的 HTTP 请求转发到本容器的 `:8653` 即可。traefik label 示例（HTTP router，注意不是 tcp router）：

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.dns-probe.entrypoints=http
  - traefik.http.routers.dns-probe.rule=Host(`ns-probe.palemoky.com`)
  - traefik.http.services.dns-probe.loadbalancer.server.port=8653
```

验证：`curl "http://ns-probe.palemoky.com/lookup?id=abc123"` 能返回 JSON 即可。

## 前端接入（已合入主站）

主站 `public/app.js` 的「DNS 解析器归属」检测已实现，无需本服务对外暴露 HTTPS：

1. 前端 `fetch("https://<uuid>.d.palemoky.com/", { mode: "no-cors" })` 触发浏览器解析器查询本服务（连接失败无妨，DNS 解析已发生）。
2. 前端调用主站 **`/api/dns-lookup?id=<uuid>`**——由 Cloudflare Worker **服务端**代理请求本服务的 `http://ns-probe.palemoky.com/lookup`，回收解析器出口 IP 并顺带做 chnroutes 判定后返回。
3. 浏览器全程只与主站 HTTPS 通信，因此本服务的查询 API **只需 HTTP:80**（经 traefik 暴露即可），不必解决 VPS 侧的 HTTPS/443 问题。

> Worker 中的上游地址常量为 `DNS_PROBE_LOOKUP`（`src/index.ts`），委派子域常量为 `DNS_PROBE_ZONE`（`public/app.js`），按你的实际域名调整。
> `<uuid>.d.palemoky.com` 无需真正响应 HTTP，只要能触发 DNS 解析即可（本服务对任意 `*.<zone>` 都返回 `-answer` 指定的 A 记录）。

## 隐私

服务仅在内存保留最多 10 分钟的 `uuid → 解析器IP` 映射用于本次查询，不落盘、不关联身份。生产部署建议在日志里关掉 `query ...` 那行。
