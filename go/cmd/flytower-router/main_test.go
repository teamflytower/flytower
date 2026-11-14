package main

import (
	"bytes"
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/teamflytower/flytower/go/router"
	"github.com/teamflytower/flytower/go/router/control"
)

func TestVersion(t *testing.T) {
	for _, args := range [][]string{{"--version"}, {"version"}} {
		var out, errs bytes.Buffer
		if code := run(args, nil, &out, &errs); code != 0 {
			t.Fatalf("%q: exit %d", args, code)
		}
		if got := out.String(); got != "flytower-router dev\n" {
			t.Errorf("%q: printed %q", args, got)
		}
	}
}

func TestVersionFromRelease(t *testing.T) {
	release := t.TempDir()
	exe := filepath.Join(release, "bin", "flytower-router")
	if got := versionBeside(exe, "dev"); got != "dev" {
		t.Errorf("no VERSION file: got %q", got)
	}
	if err := os.WriteFile(filepath.Join(release, "VERSION"), []byte("1.5.0-beta.2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(release, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := versionBeside(exe, "dev"); got != "1.5.0-beta.2" {
		t.Errorf("got %q", got)
	}
	if got := releaseVersion("1.2.3"); got != "1.2.3" {
		t.Errorf("a stamped version wins: got %q", got)
	}
}

func TestUsage(t *testing.T) {
	for _, args := range [][]string{nil, {"--nope"}, {"ctl"}} {
		var out, errs bytes.Buffer
		if code := run(args, nil, &out, &errs); code != 2 {
			t.Errorf("%q: exit %d, want 2", args, code)
		}
		if !strings.Contains(errs.String(), "usage") {
			t.Errorf("%q: no usage message", args)
		}
	}
}

func TestCtl(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "router.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &control.Server{Router: router.New(router.Config{}), StatePath: filepath.Join(dir, "routes.json"), Version: "test"}
	go func() { _ = s.Serve(ctx, ln) }()

	var out, errs bytes.Buffer
	if code := run([]string{"ctl", "-control", sock, "ping"}, nil, &out, &errs); code != 0 {
		t.Fatalf("ping: exit %d: %s", code, errs.String())
	}
	if !strings.Contains(out.String(), `"routerVersion": "test"`) {
		t.Errorf("ping printed %s", out.String())
	}

	table := `{"routes":[],"messages":{"unknownMotd":"","unknownDisconnect":"","stoppedMotd":"","stoppedDisconnect":"","startingMotd":"","startingDisconnect":"","bannedDisconnect":""}}`
	out.Reset()
	if code := run([]string{"ctl", "-control", sock, "routes.set", "-"}, strings.NewReader("\n"+table+"\n"), &out, &errs); code != 0 {
		t.Fatalf("routes.set: exit %d: %s", code, errs.String())
	}

	errs.Reset()
	if code := run([]string{"ctl", "-control", sock, "routes.set", "{}"}, nil, &out, &errs); code != 1 {
		t.Errorf("bad table: exit %d", code)
	}
	if !strings.Contains(errs.String(), "invalid_params") {
		t.Errorf("bad table: %s", errs.String())
	}
}
