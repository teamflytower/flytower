// Package control serves the router's control socket. It speaks the agent's envelope (one
// JSON message per line, see go/protocol) with the verbs in packages/protocol/src/router.ts:
// ping, routes.set and routes.status. The last route table is kept on disk, so players can
// still join while the panel restarts.
package control

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"slices"
	"sync"

	"github.com/teamflytower/flytower/go/protocol"
	"github.com/teamflytower/flytower/go/router"
	"github.com/teamflytower/flytower/go/router/route"
)

// Server answers requests on the control socket.
type Server struct {
	Router *router.Router
	// StatePath is where the last route table is kept. Empty keeps nothing.
	StatePath string
	Version   string
	// AllowUIDs may use the socket, besides root and the router's own user.
	AllowUIDs []uint32
	Logger    *slog.Logger

	mu sync.Mutex // one routes.set at a time, so the file and the router agree
}

// LoadState reads the table kept at path. A missing file gives an empty table.
func LoadState(path string) (*route.Table, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return route.Empty(), nil
	}
	if err != nil {
		return nil, err
	}
	return route.Parse(data)
}

// saveState writes the table atomically: a temporary file, synced, then renamed over the old.
func saveState(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".routes-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func (s *Server) log() *slog.Logger {
	if s.Logger == nil {
		return slog.New(slog.DiscardHandler)
	}
	return s.Logger
}

// Serve accepts connections on ln until ctx ends.
func (s *Server) Serve(ctx context.Context, ln *net.UnixListener) error {
	stop := context.AfterFunc(ctx, func() { _ = ln.Close() })
	defer stop()
	for {
		c, err := ln.AcceptUnix()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go s.conn(ctx, c)
	}
}

func (s *Server) allowed(c *net.UnixConn) bool {
	uid, err := peerUID(c)
	if err != nil {
		s.log().Warn("can't tell who's on the control socket", "err", err)
		return false
	}
	return uid == 0 || uid == uint32(os.Getuid()) || slices.Contains(s.AllowUIDs, uid)
}

func (s *Server) conn(ctx context.Context, c *net.UnixConn) {
	defer c.Close()
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	defer stop()
	if !s.allowed(c) {
		_, _ = c.Write(protocol.Fail("unknown", protocol.NewError(protocol.Forbidden, "not allowed")).Encode())
		return
	}
	r := bufio.NewReaderSize(c, 4096)
	for {
		line, err := readLine(r)
		if err != nil {
			if errors.Is(err, errTooLong) {
				_, _ = c.Write(protocol.Fail("unknown", protocol.NewError(protocol.BadRequest, "message too long")).Encode())
			}
			return
		}
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		if _, err := c.Write(s.Handle(line).Encode()); err != nil {
			return
		}
	}
}

var errTooLong = errors.New("line too long")

func readLine(r *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, err := r.ReadSlice('\n')
		line = append(line, chunk...)
		if len(line) > protocol.MaxLineBytes {
			return nil, errTooLong
		}
		if err == nil {
			return line, nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return nil, err
		}
	}
}

// Handle answers one request line.
func (s *Server) Handle(line []byte) protocol.Response {
	req, err := protocol.ParseRequest(line)
	if err != nil {
		return protocol.Fail("unknown", protocol.NewError(protocol.BadRequest, "not a valid request"))
	}
	result, perr := s.dispatch(req)
	if perr != nil {
		return protocol.Fail(req.ID, perr)
	}
	return protocol.OK(req.ID, result)
}

func (s *Server) dispatch(req protocol.Request) (any, *protocol.Error) {
	switch req.Verb {
	case "ping":
		if !isEmptyObject(req.Params) {
			return nil, protocol.NewError(protocol.InvalidParams, "ping takes no params")
		}
		return map[string]any{"routerVersion": s.Version, "protocol": protocol.Version}, nil
	case "routes.status":
		if !isEmptyObject(req.Params) {
			return nil, protocol.NewError(protocol.InvalidParams, "routes.status takes no params")
		}
		return s.Router.Status(), nil
	case "routes.set":
		t, err := route.Parse(req.Params)
		if err != nil {
			return nil, protocol.NewError(protocol.InvalidParams, err.Error())
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.StatePath != "" {
			if err := saveState(s.StatePath, req.Params); err != nil {
				return nil, protocol.NewError(protocol.Failed, fmt.Sprintf("keeping the routes: %v", err))
			}
		}
		s.Router.SetTable(t)
		s.log().Info("routes set", "routes", len(t.Routes))
		return map[string]int{"routes": len(t.Routes)}, nil
	}
	return nil, protocol.NewError(protocol.UnknownVerb, "unknown verb "+req.Verb)
}

func isEmptyObject(raw json.RawMessage) bool {
	var m map[string]json.RawMessage
	return json.Unmarshal(raw, &m) == nil && m != nil && len(m) == 0
}
