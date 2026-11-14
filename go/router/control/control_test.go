package control

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"

	"github.com/teamflytower/flytower/go/router"
)

const table = `{"routes":[{"name":"survival","hostnames":["mc.example.com"],"port":25566,"state":"running","proxyProtocol":false,"bans":[]}],"messages":{"unknownMotd":"a","unknownDisconnect":"b","stoppedMotd":"c","stoppedDisconnect":"d","startingMotd":"e","startingDisconnect":"f","bannedDisconnect":"g"}}`

func request(id, verb, params string) []byte {
	return []byte(`{"id":"` + id + `","verb":"` + verb + `","params":` + params + "}\n")
}

type reply struct {
	ID     string
	OK     bool
	Result json.RawMessage
	Error  struct{ Code, Message string }
}

func decode(t *testing.T, line []byte) reply {
	t.Helper()
	var r reply
	if err := json.Unmarshal(line, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func newServer(t *testing.T) *Server {
	return &Server{Router: router.New(router.Config{}), StatePath: filepath.Join(t.TempDir(), "routes.json"), Version: "1.5.0"}
}

func TestVerbs(t *testing.T) {
	s := newServer(t)
	for _, tc := range []struct {
		name, verb, params, code string
	}{
		{"ping", "ping", `{}`, ""},
		{"ping with params", "ping", `{"x":1}`, "invalid_params"},
		{"status", "routes.status", `{}`, ""},
		{"set", "routes.set", table, ""},
		{"set refused", "routes.set", `{"routes":[]}`, "invalid_params"},
		{"unknown verb", "routes.delete", `{}`, "unknown_verb"},
	} {
		r := decode(t, s.Handle(request("1", tc.verb, tc.params)).Encode())
		if r.ID != "1" || r.OK != (tc.code == "") || r.Error.Code != tc.code {
			t.Errorf("%s: %+v", tc.name, r)
		}
	}
	if r := decode(t, s.Handle([]byte(`{"verb":"ping"}`)).Encode()); r.Error.Code != "bad_request" {
		t.Errorf("bad envelope: %+v", r)
	}

	// routes.set is applied and kept.
	if s.Router.Table().Lookup("mc.example.com") == nil {
		t.Error("table not applied")
	}
	kept, err := LoadState(s.StatePath)
	if err != nil || kept.Lookup("mc.example.com") == nil {
		t.Errorf("table not kept: %v", err)
	}
	var status router.Status
	r := decode(t, s.Handle(request("2", "routes.status", `{}`)).Encode())
	if err := json.Unmarshal(r.Result, &status); err != nil || len(status.Routes) != 1 || status.Routes[0].Name != "survival" {
		t.Errorf("status %s", r.Result)
	}
}

func TestLoadStateMissing(t *testing.T) {
	tab, err := LoadState(filepath.Join(t.TempDir(), "none.json"))
	if err != nil || len(tab.Routes) != 0 {
		t.Errorf("%v %v", tab, err)
	}
}

func TestSocket(t *testing.T) {
	s := newServer(t)
	path := filepath.Join(t.TempDir(), "router.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = s.Serve(ctx, ln) }()

	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	r := bufio.NewReader(c)
	_, _ = c.Write(append(request("a", "ping", `{}`), request("b", "routes.set", table)...))
	for _, id := range []string{"a", "b"} {
		line, err := r.ReadBytes('\n')
		if err != nil {
			t.Fatal(err)
		}
		if got := decode(t, line); got.ID != id || !got.OK {
			t.Errorf("%s: %s", id, line)
		}
	}
	_, _ = c.Write(append(bytes.Repeat([]byte("x"), 70*1024), '\n'))
	line, _ := r.ReadBytes('\n')
	if got := decode(t, line); got.Error.Code != "bad_request" {
		t.Errorf("overlong line: %s", line)
	}
}

// The router's other verbs, against protocol/fixtures/router.jsonl (routes.set is checked in
// package route).
func TestFixtures(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "protocol", "fixtures", "router.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range bytes.Split(bytes.TrimSpace(data), []byte("\n")) {
		var fx struct {
			Verb, Kind, Note string
			Valid            bool
			Value            json.RawMessage
		}
		if err := json.Unmarshal(line, &fx); err != nil {
			t.Fatal(err)
		}
		var got bool
		switch {
		case fx.Verb == "routes.set":
			continue
		case fx.Kind == "params":
			got = isEmptyObject(fx.Value)
		case fx.Verb == "routes.status":
			got = strictDecode(fx.Value, &router.Status{})
		case fx.Verb == "ping":
			got = strictDecode(fx.Value, &struct {
				RouterVersion string `json:"routerVersion"`
				Protocol      int    `json:"protocol"`
			}{})
		default:
			t.Fatalf("unknown verb %s", fx.Verb)
		}
		if got != fx.Valid {
			t.Errorf("%s %s %s: accepted %v, want %v", fx.Verb, fx.Kind, fx.Note, got, fx.Valid)
		}
	}
}

func strictDecode(raw json.RawMessage, v any) bool {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	return dec.Decode(v) == nil
}
