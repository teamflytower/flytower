package route

import (
	"bufio"
	"encoding/json"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
)

func TestFixtures(t *testing.T) {
	f, err := os.Open(filepath.Join("..", "..", "..", "protocol", "fixtures", "router.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(nil, 1<<20)
	seen := 0
	for sc.Scan() {
		var fx struct {
			Verb, Kind, Note string
			Valid            bool
			Value            json.RawMessage
		}
		if err := json.Unmarshal(sc.Bytes(), &fx); err != nil {
			t.Fatal(err)
		}
		if fx.Verb != "routes.set" || fx.Kind != "params" {
			continue // the other verbs are checked in package control
		}
		seen++
		_, err := Parse(fx.Value)
		if (err == nil) != fx.Valid {
			t.Errorf("%s: accepted %v, want %v (%v)", fx.Note, err == nil, fx.Valid, err)
		}
	}
	if seen == 0 {
		t.Fatal("no routes.set lines")
	}
}

func table(t *testing.T, routes string) *Table {
	t.Helper()
	m, _ := json.Marshal(DefaultMessages)
	tab, err := Parse([]byte(`{"routes":` + routes + `,"messages":` + string(m) + `}`))
	if err != nil {
		t.Fatal(err)
	}
	return tab
}

func TestLookup(t *testing.T) {
	tab := table(t, `[
		{"name":"survival","hostnames":["survival.mc.example.com","mc.example.com"],"port":25566,"state":"running","proxyProtocol":false,"bans":[]},
		{"name":"creative","hostnames":["*.mc.example.com"],"port":25567,"state":"running","proxyProtocol":false,"bans":[]}
	]`)
	for host, want := range map[string]string{
		"survival.mc.example.com":   "survival",
		"mc.example.com":            "survival",
		"anything.mc.example.com":   "creative",
		"a.b.mc.example.com":        "",
		"example.com":               "",
		"survival.mc.example.com.x": "",
	} {
		got := ""
		if r := tab.Lookup(host); r != nil {
			got = r.Name
		}
		if got != want {
			t.Errorf("%s: got %q, want %q", host, got, want)
		}
	}
}

func TestBans(t *testing.T) {
	tab := table(t, `[{"name":"survival","hostnames":["mc.example.com"],"port":25566,"state":"running","proxyProtocol":false,
		"bans":["203.0.113.7","198.51.100.0/24","2001:db8::/32","::ffff:192.0.2.1"]}]`)
	r := tab.Lookup("mc.example.com")
	for addr, want := range map[string]bool{
		"203.0.113.7":        true,
		"::ffff:203.0.113.7": true,
		"198.51.100.200":     true,
		"198.51.101.1":       false,
		"2001:db8:1::5":      true,
		"2001:db9::1":        false,
		"192.0.2.1":          true,
		"203.0.113.8":        false,
	} {
		if got := r.Banned(netip.MustParseAddr(addr)); got != want {
			t.Errorf("%s: banned %v, want %v", addr, got, want)
		}
	}
}

func TestEmpty(t *testing.T) {
	if r := Empty().Lookup("mc.example.com"); r != nil {
		t.Error("an empty table routed something")
	}
	if Fill("There's no server at {hostname}.", "x.example.com") != "There's no server at x.example.com." {
		t.Error("Fill")
	}
}
