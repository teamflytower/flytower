package proxyproto

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"net/netip"
	"os"
	"testing"
)

// TestHeader replays protocol/fixtures/proxy-v2.jsonl, which the flytower-proxy mod reads too.
func TestHeader(t *testing.T) {
	f, err := os.Open("../../../protocol/fixtures/proxy-v2.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	lines := 0
	for s := bufio.NewScanner(f); s.Scan(); lines++ {
		var tc struct{ Note, Src, Dst, Header string }
		if err := json.Unmarshal(s.Bytes(), &tc); err != nil {
			t.Fatal(err)
		}
		t.Run(tc.Note, func(t *testing.T) {
			got, err := Header(netip.MustParseAddrPort(tc.Src), netip.MustParseAddrPort(tc.Dst))
			if err != nil {
				t.Fatal(err)
			}
			want, _ := hex.DecodeString(tc.Header)
			if !bytes.Equal(got, want) {
				t.Errorf("got  %x\nwant %x", got, want)
			}
		})
	}
	if lines == 0 {
		t.Fatal("no fixtures")
	}
	if _, err := Header(netip.AddrPort{}, netip.MustParseAddrPort("192.0.2.1:1")); err == nil {
		t.Error("accepted an invalid address")
	}
}
