// Package route holds the router's table: which hostname reaches which server, and what to
// tell players when there's no server to reach. It matches RouteTable in
// packages/protocol/src/router.ts, and its tests replay protocol/fixtures/router.jsonl.
package route

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"strings"
	"unicode/utf16"
)

// State is whether a route's server is up.
type State string

const (
	Running  State = "running"
	Starting State = "starting"
	Stopped  State = "stopped"
)

// Route sends players who typed one of its hostnames to a server on 127.0.0.1.
type Route struct {
	Name          string   `json:"name"`
	Hostnames     []string `json:"hostnames"`
	Port          int      `json:"port"`
	State         State    `json:"state"`
	ProxyProtocol bool     `json:"proxyProtocol"`
	Bans          []string `json:"bans"`

	bans []netip.Prefix
}

// Messages are the texts players see when the router answers for a server. "{hostname}"
// becomes the address the player typed.
type Messages struct {
	UnknownMOTD        string `json:"unknownMotd"`
	UnknownDisconnect  string `json:"unknownDisconnect"`
	StoppedMOTD        string `json:"stoppedMotd"`
	StoppedDisconnect  string `json:"stoppedDisconnect"`
	StartingMOTD       string `json:"startingMotd"`
	StartingDisconnect string `json:"startingDisconnect"`
	BannedDisconnect   string `json:"bannedDisconnect"`
}

// Table is the whole route table.
type Table struct {
	Routes   []*Route `json:"routes"`
	Messages Messages `json:"messages"`

	exact    map[string]*Route
	wildcard map[string]*Route // keyed by the part after "*."
}

// DefaultMessages are used until the panel sends its own.
var DefaultMessages = Messages{
	UnknownMOTD:        "No server at this address",
	UnknownDisconnect:  "There's no server at {hostname}.",
	StoppedMOTD:        "This server is stopped",
	StoppedDisconnect:  "This server is stopped.",
	StartingMOTD:       "Starting up, try again in a moment",
	StartingDisconnect: "The server is starting. Try again in a moment.",
	BannedDisconnect:   "You can't join this server.",
}

// Empty is a table with no routes and the default messages.
func Empty() *Table {
	t := &Table{Routes: []*Route{}, Messages: DefaultMessages}
	_ = t.compile()
	return t
}

var (
	serverName = regexp.MustCompile(`^[a-z][a-z0-9-]{1,30}$`)
	hostname   = regexp.MustCompile(`^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
)

const (
	maxRoutes    = 256
	maxHostnames = 16
	maxBans      = 10_000
	maxText      = 512
)

// Parse reads a table from JSON and checks it exactly as the Zod RouteTable does: unknown keys
// and missing fields are refused.
func Parse(data []byte) (*Table, error) {
	if err := requireKeys(data); err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var t Table
	if err := dec.Decode(&t); err != nil {
		return nil, err
	}
	if dec.More() {
		return nil, errors.New("trailing data after the table")
	}
	if err := t.compile(); err != nil {
		return nil, err
	}
	return &t, nil
}

// requireKeys refuses missing fields and nulls, which encoding/json would quietly zero.
func requireKeys(data []byte) error {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(data, &top); err != nil || top == nil {
		return errors.New("the table must be an object")
	}
	if err := need(top, "routes", "messages"); err != nil {
		return err
	}
	var routes []map[string]json.RawMessage
	if err := json.Unmarshal(top["routes"], &routes); err != nil || routes == nil {
		return errors.New("routes must be a list")
	}
	for i, r := range routes {
		if err := need(r, "name", "hostnames", "port", "state", "proxyProtocol", "bans"); err != nil {
			return fmt.Errorf("route %d: %w", i, err)
		}
		for _, list := range []string{"hostnames", "bans"} {
			if r[list][0] != '[' {
				return fmt.Errorf("route %d: %s must be a list", i, list)
			}
		}
	}
	var messages map[string]json.RawMessage
	if err := json.Unmarshal(top["messages"], &messages); err != nil || messages == nil {
		return errors.New("messages must be an object")
	}
	return need(messages, "unknownMotd", "unknownDisconnect", "stoppedMotd", "stoppedDisconnect",
		"startingMotd", "startingDisconnect", "bannedDisconnect")
}

func need(obj map[string]json.RawMessage, keys ...string) error {
	for _, k := range keys {
		v, ok := obj[k]
		if !ok || len(v) == 0 || string(v) == "null" {
			return fmt.Errorf("%s is missing", k)
		}
	}
	return nil
}

func jsLen(s string) int { return len(utf16.Encode([]rune(s))) }

// compile checks the table and builds its lookup maps.
func (t *Table) compile() error {
	if len(t.Routes) > maxRoutes {
		return fmt.Errorf("more than %d routes", maxRoutes)
	}
	for _, m := range []string{t.Messages.UnknownMOTD, t.Messages.UnknownDisconnect,
		t.Messages.StoppedMOTD, t.Messages.StoppedDisconnect, t.Messages.StartingMOTD,
		t.Messages.StartingDisconnect, t.Messages.BannedDisconnect} {
		if jsLen(m) > maxText {
			return fmt.Errorf("a message is over %d characters", maxText)
		}
	}
	t.exact = map[string]*Route{}
	t.wildcard = map[string]*Route{}
	names := map[string]bool{}
	for _, r := range t.Routes {
		if r == nil {
			return errors.New("a route is null")
		}
		if !serverName.MatchString(r.Name) || strings.HasSuffix(r.Name, "-") {
			return fmt.Errorf("%q isn't a server name", r.Name)
		}
		if names[r.Name] {
			return fmt.Errorf("route names must be unique: %s", r.Name)
		}
		names[r.Name] = true
		if len(r.Hostnames) < 1 || len(r.Hostnames) > maxHostnames {
			return fmt.Errorf("%s: a route needs 1 to %d hostnames", r.Name, maxHostnames)
		}
		if r.Port < 1 || r.Port > 65535 {
			return fmt.Errorf("%s: port %d is out of range", r.Name, r.Port)
		}
		switch r.State {
		case Running, Starting, Stopped:
		default:
			return fmt.Errorf("%s: unknown state %q", r.Name, r.State)
		}
		for _, h := range r.Hostnames {
			if len(h) > 253 || !hostname.MatchString(h) {
				return fmt.Errorf("%s: %q isn't a lower-case hostname", r.Name, h)
			}
			key, m := h, t.exact
			if rest, ok := strings.CutPrefix(h, "*."); ok {
				key, m = rest, t.wildcard
			}
			if _, dup := m[key]; dup {
				return fmt.Errorf("a hostname can only belong to one route: %s", h)
			}
			m[key] = r
		}
		if len(r.Bans) > maxBans {
			return fmt.Errorf("%s: more than %d bans", r.Name, maxBans)
		}
		r.bans = make([]netip.Prefix, 0, len(r.Bans))
		for _, b := range r.Bans {
			p, err := parseBan(b)
			if err != nil {
				return fmt.Errorf("%s: %q isn't an address or a range", r.Name, b)
			}
			r.bans = append(r.bans, p)
		}
	}
	return nil
}

// parseBan accepts an address or a CIDR range. IPv4 addresses written inside IPv6
// (::ffff:203.0.113.7) are turned into plain IPv4, as players' addresses are.
func parseBan(s string) (netip.Prefix, error) {
	var p netip.Prefix
	if strings.Contains(s, "/") {
		var err error
		if p, err = netip.ParsePrefix(s); err != nil {
			return p, err
		}
	} else {
		a, err := netip.ParseAddr(s)
		if err != nil {
			return p, err
		}
		p = netip.PrefixFrom(a, a.BitLen())
	}
	if p.Addr().Zone() != "" {
		return netip.Prefix{}, errors.New("addresses with a zone can't be banned")
	}
	if p.Addr().Is4In6() && p.Bits() >= 96 {
		p = netip.PrefixFrom(p.Addr().Unmap(), p.Bits()-96)
	}
	return p.Masked(), nil
}

// Lookup finds the route for a normalised hostname: an exact match first, then a wildcard
// for everything after the first label.
func (t *Table) Lookup(host string) *Route {
	if r, ok := t.exact[host]; ok {
		return r
	}
	if _, rest, ok := strings.Cut(host, "."); ok {
		if r, ok := t.wildcard[rest]; ok {
			return r
		}
	}
	return nil
}

// Banned reports whether a player's address is turned away by this route.
func (r *Route) Banned(addr netip.Addr) bool {
	addr = addr.Unmap()
	for _, p := range r.bans {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// Fill puts the hostname the player typed into a message.
func Fill(message, host string) string {
	return strings.ReplaceAll(message, "{hostname}", host)
}
