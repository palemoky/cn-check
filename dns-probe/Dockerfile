# ---- 构建阶段 ----
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
# 静态编译，无 CGO，便于放进 scratch
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /dns-probe .

# ---- 运行阶段 ----
FROM scratch
COPY --from=build /dns-probe /dns-probe
# DNS(UDP) 与查询 API(TCP)
EXPOSE 53/udp
EXPOSE 8080/tcp
ENTRYPOINT ["/dns-probe"]
# 默认参数，可在 docker run / compose 中覆盖
CMD ["-zone", "d.example.com", "-answer", "127.0.0.1", "-dns", ":53", "-http", ":8080"]
