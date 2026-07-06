// 极简权威 DNS 服务器 + 查询 API，用于 DNS 泄露 / 解析器归属检测。
//
// 工作原理：
//   1. 前端请求一张图片 https://<uuid>.d.example.com/... （或直接解析该域名）
//   2. 用户的递归解析器（而非浏览器）会来本服务器查询该子域的 A 记录
//   3. 本服务器记录「哪个 IP（即解析器出口）查询了哪个 uuid」
//   4. 前端再调用 GET /lookup?id=<uuid>，拿到解析器出口 IP
//   5. 前端把该 IP 交给主站 /api/ip-china 判断是否属于中国大陆
//
// 若解析器出口在中国大陆、而 HTTP 出口在境外，则是「DNS 未走代理」的分流特征。
//
// 无第三方依赖，标准库实现。构建：go build -o dns-probe .
package main

import (
	"encoding/json"
	"flag"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type record struct {
	resolvers map[string]bool
	seen      time.Time
}

type store struct {
	mu   sync.Mutex
	data map[string]*record
}

func newStore() *store {
	s := &store{data: make(map[string]*record)}
	// 每 10 分钟清理超过 10 分钟的记录，避免内存无限增长
	go func() {
		for range time.Tick(10 * time.Minute) {
			s.mu.Lock()
			for k, v := range s.data {
				if time.Since(v.seen) > 10*time.Minute {
					delete(s.data, k)
				}
			}
			s.mu.Unlock()
		}
	}()
	return s
}

func (s *store) add(id, resolver string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.data[id]
	if r == nil {
		r = &record{resolvers: make(map[string]bool)}
		s.data[id] = r
	}
	r.resolvers[resolver] = true
	r.seen = time.Now()
}

func (s *store) get(id string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.data[id]
	if r == nil {
		return nil
	}
	out := make([]string, 0, len(r.resolvers))
	for ip := range r.resolvers {
		out = append(out, ip)
	}
	return out
}

var (
	zone     = flag.String("zone", "d.example.com", "本服务器权威的委派子域（末尾不带点）")
	answerIP = flag.String("answer", "127.0.0.1", "A 记录返回的 IPv4（一般填本机公网 IP）")
	dnsAddr  = flag.String("dns", ":53", "DNS 监听地址")
	httpAddr = flag.String("http", ":8080", "查询 API 监听地址")
)

func main() {
	flag.Parse()
	s := newStore()
	go serveDNS(s)
	serveHTTP(s)
}

// ---- DNS 服务：仅解析 A 记录，标准库手写报文 ----

func serveDNS(s *store) {
	conn, err := net.ListenPacket("udp", *dnsAddr)
	if err != nil {
		log.Fatalf("DNS 监听失败: %v", err)
	}
	log.Printf("DNS 权威服务器已启动 %s，zone=%s", *dnsAddr, *zone)
	buf := make([]byte, 512)
	for {
		n, addr, err := conn.ReadFrom(buf)
		if err != nil {
			continue
		}
		resolver, _, _ := net.SplitHostPort(addr.String())
		go handleDNS(conn, addr, append([]byte(nil), buf[:n]...), resolver, s)
	}
}

func handleDNS(conn net.PacketConn, addr net.Addr, req []byte, resolver string, s *store) {
	name, ok := parseQName(req)
	if !ok {
		return
	}
	name = strings.ToLower(strings.TrimSuffix(name, "."))
	// 期望 <uuid>.<zone>；提取最左标签作为 uuid
	if id, ok := strings.CutSuffix(name, "."+*zone); ok {
		if i := strings.LastIndex(id, "."); i >= 0 {
			id = id[i+1:]
		}
		if id != "" {
			s.add(id, resolver)
			log.Printf("query id=%s resolver=%s", id, resolver)
		}
	}
	if resp := buildResponse(req, net.ParseIP(*answerIP).To4()); resp != nil {
		conn.WriteTo(resp, addr)
	}
}

// 从 DNS 请求中提取被查询的域名（QNAME）
func parseQName(msg []byte) (string, bool) {
	if len(msg) < 12 {
		return "", false
	}
	pos := 12 // 跳过 12 字节头部
	var sb strings.Builder
	for {
		if pos >= len(msg) {
			return "", false
		}
		l := int(msg[pos])
		pos++
		if l == 0 {
			break
		}
		if pos+l > len(msg) {
			return "", false
		}
		sb.Write(msg[pos : pos+l])
		sb.WriteByte('.')
		pos += l
	}
	return sb.String(), true
}

// 构造一条包含单个 A 记录的应答（复用请求的 question 段）
func buildResponse(req []byte, ipv4 net.IP) []byte {
	if len(req) < 12 || ipv4 == nil {
		return nil
	}
	// 找到 question 段结束位置
	pos := 12
	for pos < len(req) && req[pos] != 0 {
		pos += int(req[pos]) + 1
	}
	pos += 5 // 0 结束符 + QTYPE(2) + QCLASS(2)
	if pos > len(req) {
		return nil
	}
	resp := make([]byte, 0, pos+16)
	resp = append(resp, req[:pos]...)
	// 头部：ID 保留；设置 QR=1 AA=1，ANCOUNT=1
	resp[2] = 0x84 // QR=1, Opcode=0, AA=1
	resp[3] = 0x00
	resp[6], resp[7] = 0x00, 0x01 // ANCOUNT=1
	resp[8], resp[9] = 0x00, 0x00 // NSCOUNT=0
	resp[10], resp[11] = 0x00, 0x00
	// answer：name 用指针指向 question(0x0c)，TYPE=A CLASS=IN TTL=60 RDLENGTH=4
	resp = append(resp,
		0xc0, 0x0c,
		0x00, 0x01,
		0x00, 0x01,
		0x00, 0x00, 0x00, 0x3c,
		0x00, 0x04,
		ipv4[0], ipv4[1], ipv4[2], ipv4[3],
	)
	return resp
}

// ---- 查询 API：前端用 uuid 查解析器出口 IP ----

func serveHTTP(s *store) {
	http.HandleFunc("/lookup", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")
		id := r.URL.Query().Get("id")
		json.NewEncoder(w).Encode(map[string]any{
			"id":        id,
			"resolvers": s.get(id),
		})
	})
	log.Printf("查询 API 已启动 %s", *httpAddr)
	log.Fatal(http.ListenAndServe(*httpAddr, nil))
}
