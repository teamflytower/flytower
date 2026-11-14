package protocol

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixture is one line of protocol/fixtures/*.jsonl, which the TypeScript and Rust tests replay
// too (see protocol/fixtures/README.md).
type fixture struct {
	Kind  string          `json:"kind"`
	Valid bool            `json:"valid"`
	Note  string          `json:"note"`
	Value json.RawMessage `json:"value"`
}

func readFixtures(t *testing.T, name string) []fixture {
	t.Helper()
	f, err := os.Open(filepath.Join("..", "..", "protocol", "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []fixture
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), MaxLineBytes*2)
	for sc.Scan() {
		if len(sc.Bytes()) == 0 {
			continue
		}
		var fx fixture
		if err := json.Unmarshal(sc.Bytes(), &fx); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		out = append(out, fx)
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	if len(out) == 0 {
		t.Fatalf("%s is empty", name)
	}
	return out
}

func TestEnvelopeFixtures(t *testing.T) {
	for _, fx := range readFixtures(t, "envelope.jsonl") {
		var got bool
		switch fx.Kind {
		case "request":
			_, err := ParseRequest(fx.Value)
			got = err == nil
		case "response":
			got = ValidResponse(fx.Value)
		case "subscribe", "cancel", "frame":
			// Protocol version 2's subscriptions: the agent's, which the router doesn't use.
			continue
		default:
			t.Fatalf("unknown kind %q", fx.Kind)
		}
		if got != fx.Valid {
			t.Errorf("%s %s (%s): accepted %v, want %v", fx.Kind, fx.Value, fx.Note, got, fx.Valid)
		}
	}
}

// Whatever Go sends must pass its own check, which the fixtures tie to Zod.
func TestEncodedResponsesAreValid(t *testing.T) {
	for _, r := range []Response{
		OK("1", map[string]int{"protocol": Version}),
		OK("2", nil),
		Fail("3", NewError(NotFound, "no such route")),
	} {
		line := r.Encode()
		if line[len(line)-1] != '\n' {
			t.Errorf("%s: no newline", line)
		}
		if !ValidResponse(line) {
			t.Errorf("%s: not a valid response", line)
		}
	}
}

func TestIDLengthCountsLikeJavaScript(t *testing.T) {
	// 32 emoji are 64 UTF-16 code units, the most Zod allows; 33 are too many.
	ok := `{"id":"` + strings.Repeat("😀", 32) + `","verb":"ping","params":{}}`
	long := `{"id":"` + strings.Repeat("😀", 33) + `","verb":"ping","params":{}}`
	if _, err := ParseRequest([]byte(ok)); err != nil {
		t.Error("64 code units refused")
	}
	if _, err := ParseRequest([]byte(long)); err == nil {
		t.Error("66 code units accepted")
	}
}
