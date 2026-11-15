// Command flytower-router routes Minecraft players to a server by the hostname they typed, so
// every server on a machine can share port 25565 (#76). The work is done by the packages in
// go/router; this is the command line around them.
//
//	flytower-router serve [flags]          run the router
//	flytower-router ctl <verb> [params]    send one request to a running router's control socket
//	flytower-router --version
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/teamflytower/flytower/go/protocol"
	"github.com/teamflytower/flytower/go/router"
	"github.com/teamflytower/flytower/go/router/control"
	"github.com/teamflytower/flytower/go/router/handshake"
)

// version is the release this binary came with. Releases don't stamp it in at build time:
// the binary would then differ in every release, and the agent restarts the router (dropping
// every player) whenever its binary changes. It's read from the release's VERSION file instead
// (see releaseVersion). -ldflags "-X main.version=..." still works for a build of your own.
var version = "dev"

const (
	defaultControl = "/run/flytower-router/router.sock"
	defaultState   = "/var/lib/flytower-router/routes.json"
)

func main() {
	version = releaseVersion(version)
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

// releaseVersion is the version stamped in at build time, or else the one in the VERSION file
// of the release this binary is in (<release>/bin/flytower-router beside <release>/VERSION).
func releaseVersion(stamped string) string {
	if stamped != "dev" {
		return stamped
	}
	exe, err := os.Executable()
	if err != nil {
		return stamped
	}
	return versionBeside(exe, stamped)
}

// versionBeside reads <dir of exe>/../VERSION, or returns fallback.
func versionBeside(exe, fallback string) string {
	b, err := os.ReadFile(filepath.Join(filepath.Dir(exe), "..", "VERSION"))
	if err != nil {
		return fallback
	}
	v := strings.TrimSpace(string(b))
	if v == "" || len(v) > 64 || strings.ContainsAny(v, " \t\n") {
		return fallback
	}
	return v
}

func usage(w io.Writer) {
	fmt.Fprint(w, `usage:
  flytower-router serve [flags]          run the router (see serve -h)
  flytower-router ctl <verb> [params]    send a request to a running router, e.g.
                                         flytower-router ctl routes.status
                                         flytower-router ctl routes.set - < routes.json
  flytower-router --version
`)
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		usage(stderr)
		return 2
	}
	switch args[0] {
	case "--version", "-version", "version":
		fmt.Fprintf(stdout, "flytower-router %s\n", version)
		return 0
	case "serve":
		return serve(args[1:], stderr)
	case "ctl":
		return ctl(args[1:], stdin, stdout, stderr)
	case "-h", "--help", "help":
		usage(stdout)
		return 0
	}
	usage(stderr)
	return 2
}

func serve(args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(stderr)
	listen := fs.String("listen", ":25565", "address players connect to")
	controlPath := fs.String("control", defaultControl, "control socket")
	statePath := fs.String("state", defaultState, "where the last route table is kept")
	allow := fs.String("allow-user", "flytower", "users who may use the control socket, comma-separated (root always may)")
	maxConns := fs.Int("max-conns", 4096, "most open connections in total")
	maxPerIP := fs.Int("max-conns-per-ip", 64, "most open connections from one address")
	timeout := fs.Duration("handshake-timeout", 5*time.Second, "how long a client has to say which server it wants")
	verbose := fs.Bool("verbose", false, "log every connection")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	level := slog.LevelInfo
	if *verbose {
		level = slog.LevelDebug
	}
	// systemd's journal adds its own timestamps.
	log := slog.New(slog.NewTextHandler(stderr, &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			if a.Key == slog.TimeKey {
				return slog.Attr{}
			}
			return a
		},
	}))

	r := router.New(router.Config{
		Protocol:         handshake.Minecraft{ServerName: "Flytower"},
		HandshakeTimeout: *timeout,
		MaxConns:         *maxConns,
		MaxConnsPerIP:    *maxPerIP,
		Logger:           log,
	})
	table, err := control.LoadState(*statePath)
	if err != nil {
		// Better to run with no routes (every address says so) than not at all.
		log.Error("couldn't read the kept routes; starting with none", "path", *statePath, "err", err)
	} else {
		r.SetTable(table)
	}

	ctl := &control.Server{Router: r, StatePath: *statePath, Version: version, Logger: log}
	for name := range strings.SplitSeq(*allow, ",") {
		if name = strings.TrimSpace(name); name == "" {
			continue
		}
		u, err := user.Lookup(name)
		if err != nil {
			log.Warn("no such user for the control socket", "user", name)
			continue
		}
		uid, _ := strconv.ParseUint(u.Uid, 10, 32)
		ctl.AllowUIDs = append(ctl.AllowUIDs, uint32(uid))
	}

	_ = os.Remove(*controlPath)
	cln, err := net.ListenUnix("unix", &net.UnixAddr{Name: *controlPath, Net: "unix"})
	if err != nil {
		log.Error("can't open the control socket", "path", *controlPath, "err", err)
		return 1
	}
	// Anyone may connect; the router checks who they are (SO_PEERCRED) before answering.
	if err := os.Chmod(*controlPath, 0o666); err != nil {
		log.Error("can't open up the control socket", "err", err)
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go reloadOnHangup(ctx, r, *statePath, log)
	// Set when the control socket fails, so that stop is reported as a failure, not a signal.
	var ctlFailed atomic.Bool
	go func() {
		if err := ctl.Serve(ctx, cln); err != nil {
			log.Error("control socket failed", "err", err)
			ctlFailed.Store(true)
			stop()
		}
	}()
	// The control socket is up first, so the panel can send routes while we wait for the port.
	ln, err := listenWhenFree(ctx, *listen, 2*time.Second, log)
	if err != nil {
		if ctx.Err() != nil {
			if ctlFailed.Load() {
				return 1
			}
			log.Info("stopped")
			return 0
		}
		log.Error("can't listen", "address", *listen, "err", err)
		return 1
	}
	log.Info("routing players", "version", version, "listen", ln.Addr().String(),
		"routes", len(r.Table().Routes), "control", *controlPath)
	if err := r.Serve(ctx, ln); err != nil {
		log.Error("listener failed", "err", err)
		return 1
	}
	if ctlFailed.Load() {
		return 1
	}
	log.Info("stopped")
	return 0
}

// listenWhenFree listens on addr, waiting while something else holds the port. When routing
// is turned on, a server that was on the router's port keeps it until its next restart, and
// exiting instead would have systemd give up on the router after a few quick restarts.
func listenWhenFree(ctx context.Context, addr string, every time.Duration, log *slog.Logger) (net.Listener, error) {
	var lc net.ListenConfig
	warned := time.Time{}
	for {
		ln, err := lc.Listen(ctx, "tcp", addr)
		if err == nil || !errors.Is(err, syscall.EADDRINUSE) {
			return ln, err
		}
		if time.Since(warned) >= time.Minute {
			log.Warn("the port is in use, probably by a server that moves off it at its next restart; waiting for it", "address", addr)
			warned = time.Now()
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(every):
		}
	}
}

// reloadOnHangup re-reads the kept routes on SIGHUP (systemctl reload), for editing them by
// hand.
func reloadOnHangup(ctx context.Context, r *router.Router, path string, log *slog.Logger) {
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	defer signal.Stop(hup)
	for {
		select {
		case <-ctx.Done():
			return
		case <-hup:
			t, err := control.LoadState(path)
			if err != nil {
				log.Error("reload failed; keeping the current routes", "err", err)
				continue
			}
			r.SetTable(t)
			log.Info("routes reloaded", "routes", len(t.Routes))
		}
	}
}

func ctl(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("ctl", flag.ContinueOnError)
	fs.SetOutput(stderr)
	controlPath := fs.String("control", defaultControl, "control socket")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() < 1 || fs.NArg() > 2 {
		usage(stderr)
		return 2
	}
	params := []byte("{}")
	if fs.NArg() == 2 {
		params = []byte(fs.Arg(1))
		if fs.Arg(1) == "-" {
			var err error
			if params, err = io.ReadAll(io.LimitReader(stdin, protocol.MaxLineBytes)); err != nil {
				fmt.Fprintln(stderr, err)
				return 1
			}
		}
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, params); err != nil {
		fmt.Fprintln(stderr, "params must be JSON")
		return 2
	}
	req, _ := json.Marshal(map[string]any{"id": "ctl", "verb": fs.Arg(0), "params": json.RawMessage(compact.Bytes())})

	c, err := net.DialTimeout("unix", *controlPath, 5*time.Second)
	if err != nil {
		fmt.Fprintf(stderr, "can't reach the router at %s: %v\n", filepath.Clean(*controlPath), err)
		return 1
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := c.Write(append(req, '\n')); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	line, err := bufio.NewReader(c).ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintln(stderr, err)
		return 1
	}
	var resp struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  *protocol.Error `json:"error"`
	}
	if err := json.Unmarshal(line, &resp); err != nil {
		fmt.Fprintf(stderr, "unexpected reply: %s\n", line)
		return 1
	}
	if !resp.OK {
		fmt.Fprintf(stderr, "%s\n", resp.Error)
		return 1
	}
	out, _ := json.MarshalIndent(resp.Result, "", "  ")
	fmt.Fprintf(stdout, "%s\n", out)
	return 0
}
