// Package router accepts game connections, reads each handshake, and forwards the connection
// to the server its hostname names, or answers for it. It's the core of flytower-router and
// knows nothing about the control socket or the command line.
package router

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/teamflytower/flytower/go/router/handshake"
	"github.com/teamflytower/flytower/go/router/proxyproto"
	"github.com/teamflytower/flytower/go/router/route"
)

// Config tunes the router. Zero values take the defaults.
type Config struct {
	Protocol handshake.Protocol
	// HandshakeTimeout is how long a client has to send its handshake, and for an answered
	// client, the whole exchange. Default 5 s.
	HandshakeTimeout time.Duration
	// MaxHandshakeBytes caps the handshake. Default 2048.
	MaxHandshakeBytes int
	// MaxConns caps open connections in total. Default 4096.
	MaxConns int
	// MaxConnsPerIP caps open connections from one address. Default 64, since players behind
	// one university or school network share an address.
	MaxConnsPerIP int
	// DialTimeout is how long to wait for a server to accept. Default 3 s.
	DialTimeout time.Duration
	// Backend is the address servers listen on. Default 127.0.0.1.
	Backend netip.Addr
	Logger  *slog.Logger
}

func (c *Config) defaults() {
	if c.Protocol == nil {
		c.Protocol = handshake.Minecraft{}
	}
	if c.HandshakeTimeout <= 0 {
		c.HandshakeTimeout = 5 * time.Second
	}
	if c.MaxHandshakeBytes <= 0 {
		c.MaxHandshakeBytes = 2048
	}
	if c.MaxConns <= 0 {
		c.MaxConns = 4096
	}
	if c.MaxConnsPerIP <= 0 {
		c.MaxConnsPerIP = 64
	}
	if c.DialTimeout <= 0 {
		c.DialTimeout = 3 * time.Second
	}
	if !c.Backend.IsValid() {
		c.Backend = netip.AddrFrom4([4]byte{127, 0, 0, 1})
	}
	if c.Logger == nil {
		c.Logger = slog.New(slog.DiscardHandler)
	}
}

// Router routes connections by hostname. Create it with New.
type Router struct {
	cfg   Config
	table atomic.Pointer[route.Table]
	since time.Time

	mu     sync.Mutex
	perIP  map[netip.Addr]int
	open   int
	counts map[string]*counter

	unknown, refused atomic.Uint64
	wg               sync.WaitGroup
}

type counter struct {
	active atomic.Int64
	total  atomic.Uint64
}

// New returns a router with an empty table.
func New(cfg Config) *Router {
	cfg.defaults()
	r := &Router{cfg: cfg, since: time.Now(), perIP: map[netip.Addr]int{}, counts: map[string]*counter{}}
	r.table.Store(route.Empty())
	return r
}

// SetTable replaces the route table. Connections already forwarded carry on.
func (r *Router) SetTable(t *route.Table) { r.table.Store(t) }

// Table returns the current route table.
func (r *Router) Table() *route.Table { return r.table.Load() }

// RouteStatus is one route's connection counts.
type RouteStatus struct {
	Name   string `json:"name"`
	Active int64  `json:"active"`
	Total  uint64 `json:"total"`
}

// Status is the routes.status result.
type Status struct {
	Since   string        `json:"since"`
	Routes  []RouteStatus `json:"routes"`
	Unknown uint64        `json:"unknown"`
	Refused uint64        `json:"refused"`
	Active  int           `json:"active"`
}

// Status returns connection counts for each route in the current table.
func (r *Router) Status() Status {
	t := r.Table()
	s := Status{
		Since:   r.since.UTC().Format(time.RFC3339),
		Routes:  make([]RouteStatus, 0, len(t.Routes)),
		Unknown: r.unknown.Load(),
		Refused: r.refused.Load(),
	}
	r.mu.Lock()
	s.Active = r.open
	for _, rt := range t.Routes {
		c := r.counterLocked(rt.Name)
		s.Routes = append(s.Routes, RouteStatus{Name: rt.Name, Active: c.active.Load(), Total: c.total.Load()})
	}
	r.mu.Unlock()
	return s
}

func (r *Router) counterLocked(name string) *counter {
	c, ok := r.counts[name]
	if !ok {
		c = &counter{}
		r.counts[name] = c
	}
	return c
}

func (r *Router) counter(name string) *counter {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.counterLocked(name)
}

// Serve accepts connections on ln until ctx ends or ln fails. On return it has stopped
// accepting; connections already open carry on until they close, and Wait waits for them.
func (r *Router) Serve(ctx context.Context, ln net.Listener) error {
	stop := context.AfterFunc(ctx, func() { _ = ln.Close() })
	defer stop()
	var delay time.Duration
	for {
		c, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() || isFDExhausted(err) {
				delay = min(max(delay*2, 5*time.Millisecond), time.Second)
				r.cfg.Logger.Warn("accept failed, retrying", "err", err, "in", delay)
				time.Sleep(delay)
				continue
			}
			return err
		}
		delay = 0
		addr := clientAddr(c)
		if !r.admit(addr) {
			r.refused.Add(1)
			_ = c.Close()
			continue
		}
		r.wg.Add(1)
		go func() {
			defer r.wg.Done()
			defer r.release(addr)
			r.handle(c, addr)
		}()
	}
}

// Wait waits for open connections to close.
func (r *Router) Wait() { r.wg.Wait() }

func clientAddr(c net.Conn) netip.AddrPort {
	if a, ok := c.RemoteAddr().(*net.TCPAddr); ok {
		ap := a.AddrPort()
		return netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port())
	}
	ap, _ := netip.ParseAddrPort(c.RemoteAddr().String())
	return ap
}

func (r *Router) admit(addr netip.AddrPort) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.open >= r.cfg.MaxConns || r.perIP[addr.Addr()] >= r.cfg.MaxConnsPerIP {
		return false
	}
	r.open++
	r.perIP[addr.Addr()]++
	return true
}

func (r *Router) release(addr netip.AddrPort) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.open--
	if r.perIP[addr.Addr()]--; r.perIP[addr.Addr()] <= 0 {
		delete(r.perIP, addr.Addr())
	}
}

func (r *Router) handle(c net.Conn, addr netip.AddrPort) {
	defer c.Close()
	log := r.cfg.Logger.With("client", addr.String())
	_ = c.SetDeadline(time.Now().Add(r.cfg.HandshakeTimeout))
	h, err := r.cfg.Protocol.ReadHello(c, r.cfg.MaxHandshakeBytes)
	if err != nil {
		r.refused.Add(1)
		if !errors.Is(err, io.EOF) {
			log.Debug("bad handshake", "err", err)
		}
		return
	}
	log = log.With("hostname", h.Hostname, "intent", h.Intent.String())
	t := r.Table()
	rt := t.Lookup(h.Hostname)
	if rt == nil {
		r.unknown.Add(1)
		log.Debug("no route")
		r.answer(c, h, t.Messages.UnknownMOTD, t.Messages.UnknownDisconnect)
		return
	}
	cnt := r.counter(rt.Name)
	cnt.total.Add(1)
	if h.Intent == handshake.Login && rt.Banned(addr.Addr()) {
		r.refused.Add(1)
		log.Info("banned", "route", rt.Name)
		r.answer(c, h, "", t.Messages.BannedDisconnect)
		return
	}
	switch rt.State {
	case route.Stopped:
		r.answer(c, h, t.Messages.StoppedMOTD, t.Messages.StoppedDisconnect)
		return
	case route.Starting:
		r.answer(c, h, t.Messages.StartingMOTD, t.Messages.StartingDisconnect)
		return
	}

	backend := netip.AddrPortFrom(r.cfg.Backend, uint16(rt.Port))
	up, err := net.DialTimeout("tcp", backend.String(), r.cfg.DialTimeout)
	if err != nil {
		// Running but not accepting yet: most likely restarting.
		log.Info("server not accepting", "route", rt.Name, "err", err)
		r.answer(c, h, t.Messages.StartingMOTD, t.Messages.StartingDisconnect)
		return
	}
	defer up.Close()
	if rt.ProxyProtocol {
		local := netip.AddrPort{}
		if a, ok := c.LocalAddr().(*net.TCPAddr); ok {
			local = a.AddrPort()
		}
		hdr, err := proxyproto.Header(addr, local)
		if err != nil {
			log.Warn("no PROXY header", "err", err)
			return
		}
		if _, err := up.Write(hdr); err != nil {
			return
		}
	}
	if _, err := up.Write(h.Raw); err != nil {
		return
	}
	_ = c.SetDeadline(time.Time{})
	cnt.active.Add(1)
	defer cnt.active.Add(-1)
	log.Debug("forwarding", "route", rt.Name, "port", strconv.Itoa(rt.Port))
	pipe(c, up)
}

// answer replies for a server and closes cleanly, so the client reads the message rather
// than a reset connection.
func (r *Router) answer(c net.Conn, h *handshake.Hello, motd, disconnect string) {
	a := handshake.Answer{MOTD: route.Fill(motd, h.Hostname), Disconnect: route.Fill(disconnect, h.Hostname)}
	if err := r.cfg.Protocol.Answer(c, h, a); err != nil {
		return
	}
	if tc, ok := c.(*net.TCPConn); ok {
		_ = tc.CloseWrite()
		_ = c.SetReadDeadline(time.Now().Add(time.Second))
		_, _ = io.Copy(io.Discard, io.LimitReader(c, 64*1024))
	}
}

// pipe copies both ways until both sides finish. On Linux, io.Copy between TCP connections
// uses splice, so the bytes don't pass through user space.
func pipe(a, b net.Conn) {
	done := make(chan struct{}, 2)
	half := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if tc, ok := dst.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		} else {
			_ = dst.Close()
		}
		done <- struct{}{}
	}
	go half(a, b)
	go half(b, a)
	<-done
	// One side has finished; give the other a moment to drain, then close both.
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		_ = a.Close()
		_ = b.Close()
		<-done
	}
}
