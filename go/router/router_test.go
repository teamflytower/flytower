package router

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/teamflytower/flytower/go/router/route"
)

func varint(b []byte, v int) []byte {
	u := uint32(v)
	for u >= 0x80 {
		b = append(b, byte(u)|0x80)
		u >>= 7
	}
	return append(b, byte(u))
}

func packet(id int, payload []byte) []byte {
	body := append(varint(nil, id), payload...)
	return append(varint(nil, len(body)), body...)
}

func mcString(s string) []byte { return append(varint(nil, len(s)), s...) }

func hello(host string, next int) []byte {
	p := varint(nil, 773)
	p = append(p, mcString(host)...)
	p = binary.BigEndian.AppendUint16(p, 25565)
	p = varint(p, next)
	return packet(0, p)
}

func readPacket(t *testing.T, r *bufio.Reader) (int, []byte) {
	t.Helper()
	n, err := binary.ReadUvarint(r)
	if err != nil {
		t.Fatalf("read packet: %v", err)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		t.Fatal(err)
	}
	id, k := binary.Uvarint(buf)
	return int(id), buf[k:]
}

// text reads a packet that holds one string, and returns its "text" field.
func text(t *testing.T, r *bufio.Reader) string {
	t.Helper()
	_, payload := readPacket(t, r)
	n, k := binary.Uvarint(payload)
	var v struct {
		Text        string
		Description struct{ Text string }
	}
	if err := json.Unmarshal(payload[k:k+int(n)], &v); err != nil {
		t.Fatal(err)
	}
	return v.Text + v.Description.Text
}

type harness struct {
	r    *Router
	addr string
}

func start(t *testing.T, cfg Config) *harness {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := New(cfg)
	go func() { _ = r.Serve(ctx, ln) }()
	t.Cleanup(func() { cancel(); r.Wait() })
	return &harness{r: r, addr: ln.Addr().String()}
}

func (h *harness) routes(t *testing.T, routes string) {
	t.Helper()
	m, _ := json.Marshal(route.DefaultMessages)
	tab, err := route.Parse([]byte(`{"routes":` + routes + `,"messages":` + string(m) + `}`))
	if err != nil {
		t.Fatal(err)
	}
	h.r.SetTable(tab)
}

func (h *harness) dial(t *testing.T) (net.Conn, *bufio.Reader) {
	t.Helper()
	c, err := net.Dial("tcp", h.addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	return c, bufio.NewReader(c)
}

// backend is a fake server that records what it's sent and replies "welcome".
func backend(t *testing.T) (port int, got chan []byte) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	got = make(chan []byte, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		_, _ = c.Write([]byte("welcome"))
		b, _ := io.ReadAll(c)
		got <- b
	}()
	return ln.Addr().(*net.TCPAddr).Port, got
}

func routeJSON(name, host string, port int, state string, proxy bool, bans string) string {
	b, _ := json.Marshal(map[string]any{"name": name, "hostnames": []string{host}, "port": port,
		"state": state, "proxyProtocol": proxy, "bans": json.RawMessage(bans)})
	return string(b)
}

func TestForwards(t *testing.T) {
	for _, proxy := range []bool{false, true} {
		h := start(t, Config{})
		port, got := backend(t)
		h.routes(t, "["+routeJSON("survival", "survival.mc.example.com", port, "running", proxy, "[]")+"]")
		c, r := h.dial(t)
		sent := append(hello("Survival.MC.example.com.\x00FML3\x00", 2), packet(0, mcString("Steve"))...)
		_, _ = c.Write(sent)
		welcome := make([]byte, 7)
		if _, err := io.ReadFull(r, welcome); err != nil || string(welcome) != "welcome" {
			t.Fatalf("server's reply: %q, %v", welcome, err)
		}
		_ = c.(*net.TCPConn).CloseWrite()
		b := <-got
		if proxy {
			if !bytes.HasPrefix(b, []byte("\r\n\r\n\x00\r\nQUIT\n\x21\x11")) {
				t.Fatalf("no PROXY v2 header: %x", b[:min(len(b), 16)])
			}
			b = b[16+12:]
		}
		if !bytes.Equal(b, sent) {
			t.Errorf("server got %x, want %x", b, sent)
		}
		if s := h.r.Status(); s.Routes[0].Total != 1 {
			t.Errorf("status %+v", s)
		}
	}
}

func TestAnswers(t *testing.T) {
	h := start(t, Config{})
	free, _ := net.Listen("tcp", "127.0.0.1:0")
	closed := free.Addr().(*net.TCPAddr).Port
	free.Close() // nothing listens here now
	h.routes(t, "["+strings.Join([]string{
		routeJSON("stopped", "stopped.example.com", 25599, "stopped", false, "[]"),
		routeJSON("starting", "starting.example.com", 25598, "starting", false, "[]"),
		routeJSON("restarting", "restarting.example.com", closed, "running", false, "[]"),
		routeJSON("banned", "banned.example.com", 25597, "running", false, `["127.0.0.0/8"]`),
	}, ",")+"]")
	for _, tc := range []struct {
		host string
		next int
		want string
	}{
		{"nowhere.example.com", 1, "No server at this address"},
		{"nowhere.example.com", 2, "There's no server at nowhere.example.com."},
		{"stopped.example.com", 1, route.DefaultMessages.StoppedMOTD},
		{"stopped.example.com", 2, route.DefaultMessages.StoppedDisconnect},
		{"starting.example.com", 2, route.DefaultMessages.StartingDisconnect},
		{"restarting.example.com", 1, route.DefaultMessages.StartingMOTD},
		{"banned.example.com", 2, route.DefaultMessages.BannedDisconnect},
	} {
		c, r := h.dial(t)
		_, _ = c.Write(hello(tc.host, tc.next))
		if tc.next == 1 {
			_, _ = c.Write(packet(0, nil))
		} else {
			_, _ = c.Write(packet(0, mcString("Steve")))
		}
		if got := text(t, r); got != tc.want {
			t.Errorf("%s (%d): %q, want %q", tc.host, tc.next, got, tc.want)
		}
		if tc.next == 1 {
			_, _ = c.Write(packet(1, []byte{0, 0, 0, 0, 0, 0, 0, 42}))
			if id, p := readPacket(t, r); id != 1 || p[7] != 42 {
				t.Errorf("%s: pong %d %x", tc.host, id, p)
			}
		}
	}
	if s := h.r.Status(); s.Unknown != 2 || s.Refused != 1 {
		t.Errorf("status %+v", s)
	}
}

func TestHandshakeDeadline(t *testing.T) {
	h := start(t, Config{HandshakeTimeout: 100 * time.Millisecond})
	c, r := h.dial(t)
	_, _ = c.Write([]byte{0x10}) // a length, then nothing
	if _, err := r.ReadByte(); err != io.EOF {
		t.Errorf("connection still open: %v", err)
	}
}

func TestLimitPerIP(t *testing.T) {
	h := start(t, Config{MaxConnsPerIP: 2, HandshakeTimeout: 2 * time.Second})
	h.dial(t)
	h.dial(t)
	time.Sleep(50 * time.Millisecond) // let the router admit both
	_, r := h.dial(t)
	if _, err := r.ReadByte(); err == nil {
		t.Fatal("third connection wasn't closed")
	}
	if s := h.r.Status(); s.Refused != 1 || s.Active != 2 {
		t.Errorf("status %+v", s)
	}
}

func TestOversizedHandshake(t *testing.T) {
	h := start(t, Config{MaxHandshakeBytes: 64})
	c, r := h.dial(t)
	_, _ = c.Write(hello(strings.Repeat("a", 100)+".example.com", 2))
	if _, err := r.ReadByte(); err == nil {
		t.Fatal("oversized handshake wasn't refused")
	}
}
