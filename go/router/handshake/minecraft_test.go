package handshake

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"testing"
)

// handshake builds a handshake packet the way a client does.
func handshake(version int32, host string, port uint16, next int32) []byte {
	body := appendVarInt(nil, 0)
	body = appendVarInt(body, version)
	body = appendString(body, host)
	body = binary.BigEndian.AppendUint16(body, port)
	body = appendVarInt(body, next)
	return append(appendVarInt(nil, int32(len(body))), body...)
}

func TestReadHello(t *testing.T) {
	for _, tc := range []struct {
		name, sent, want string
		next             int32
		intent           Intent
	}{
		{"plain status", "survival.mc.example.com", "survival.mc.example.com", 1, Status},
		{"login", "survival.mc.example.com", "survival.mc.example.com", 2, Login},
		{"transfer is a login", "survival.mc.example.com", "survival.mc.example.com", 3, Login},
		{"capitals", "Survival.MC.Example.com", "survival.mc.example.com", 2, Login},
		{"trailing dot", "survival.mc.example.com.", "survival.mc.example.com", 2, Login},
		{"forge 1.12", "survival.mc.example.com\x00FML\x00", "survival.mc.example.com", 2, Login},
		{"forge 1.13+", "survival.mc.example.com\x00FML2\x00", "survival.mc.example.com", 2, Login},
		{"forge 1.18+", "Survival.mc.example.com.\x00FML3\x00", "survival.mc.example.com", 2, Login},
		{"a port in the address", "survival.mc.example.com:25565", "survival.mc.example.com", 1, Status},
		{"an IPv6 literal", "2001:db8::1", "2001:db8::1", 1, Status},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pkt := handshake(773, tc.sent, 25565, tc.next)
			// Bytes after the handshake belong to the server and must not be read.
			rest := []byte{0x01, 0x00}
			r := bytes.NewReader(append(append([]byte{}, pkt...), rest...))
			h, err := Minecraft{}.ReadHello(r, 2048)
			if err != nil {
				t.Fatal(err)
			}
			if h.Hostname != tc.want || h.RawHostname != tc.sent {
				t.Errorf("hostname %q (raw %q), want %q", h.Hostname, h.RawHostname, tc.want)
			}
			if h.Intent != tc.intent || h.Version != 773 || h.Port != 25565 {
				t.Errorf("got %+v", h)
			}
			if !bytes.Equal(h.Raw, pkt) {
				t.Error("Raw isn't exactly the handshake")
			}
			if r.Len() != len(rest) {
				t.Errorf("read %d bytes past the handshake", len(rest)-r.Len())
			}
		})
	}
}

func TestReadHelloRefuses(t *testing.T) {
	long := make([]byte, 3000)
	for i := range long {
		long[i] = 'a'
	}
	wrongID := handshake(773, "mc.example.com", 25565, 1)
	wrongID[1] = 0x05
	for _, tc := range []struct {
		name string
		in   []byte
		want error
	}{
		{"legacy ping", []byte{0xFE, 0x01, 0xFA}, ErrLegacy},
		{"over the limit", handshake(773, string(long), 25565, 2), ErrTooLarge},
		{"endless length", []byte{0xFF, 0xFF, 0xFF, 0xFF}, ErrTooLarge},
		{"zero length", []byte{0x00}, ErrMalformed},
		{"not a handshake packet", wrongID, ErrMalformed},
		{"unknown next state", handshake(773, "mc.example.com", 25565, 7), ErrMalformed},
		{"cut short", handshake(773, "mc.example.com", 25565, 1)[:6], io.ErrUnexpectedEOF},
		{"nothing", nil, io.EOF},
		{"not UTF-8", handshake(773, "\xff\xfe", 25565, 1), ErrMalformed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Minecraft{}.ReadHello(bytes.NewReader(tc.in), 2048)
			if !errors.Is(err, tc.want) {
				t.Errorf("err %v, want %v", err, tc.want)
			}
		})
	}
}

// conn is a scripted client: it reads what the client sends from in and collects what the
// router writes.
type conn struct {
	in  *bytes.Reader
	out bytes.Buffer
}

func (c *conn) Read(p []byte) (int, error)  { return c.in.Read(p) }
func (c *conn) Write(p []byte) (int, error) { return c.out.Write(p) }

func TestAnswerStatus(t *testing.T) {
	ping := []byte{1, 2, 3, 4, 5, 6, 7, 8}
	var client bytes.Buffer
	_ = writePacket(&client, 0x00, nil)  // status request
	_ = writePacket(&client, 0x01, ping) // ping
	c := &conn{in: bytes.NewReader(client.Bytes())}
	h := &Hello{Intent: Status, Version: 773}
	if err := (Minecraft{}).Answer(c, h, Answer{MOTD: "No server at this address"}); err != nil {
		t.Fatal(err)
	}
	id, payload, err := readPacket(&c.out, 1<<16)
	if err != nil || id != 0 {
		t.Fatalf("status response: id %d, %v", id, err)
	}
	str, err := readString(bytes.NewReader(payload), 1<<16)
	if err != nil {
		t.Fatal(err)
	}
	var status struct {
		Version struct {
			Name     string
			Protocol int32
		}
		Description struct{ Text string }
	}
	if err := json.Unmarshal([]byte(str), &status); err != nil {
		t.Fatal(err)
	}
	if status.Description.Text != "No server at this address" || status.Version.Protocol != 773 {
		t.Errorf("status %s", str)
	}
	id, payload, err = readPacket(&c.out, 16)
	if err != nil || id != 1 || !bytes.Equal(payload, ping) {
		t.Errorf("pong: id %d, %x, %v", id, payload, err)
	}
}

func TestAnswerLogin(t *testing.T) {
	var client bytes.Buffer
	_ = writePacket(&client, 0x00, appendString(nil, "Steve")) // login start, cut down
	c := &conn{in: bytes.NewReader(client.Bytes())}
	h := &Hello{Intent: Login, Version: 773}
	if err := (Minecraft{}).Answer(c, h, Answer{Disconnect: "This server is stopped."}); err != nil {
		t.Fatal(err)
	}
	id, payload, err := readPacket(&c.out, 1<<16)
	if err != nil || id != 0 {
		t.Fatalf("disconnect: id %d, %v", id, err)
	}
	str, _ := readString(bytes.NewReader(payload), 1<<16)
	if str != `{"text":"This server is stopped."}` {
		t.Errorf("disconnect reason %s", str)
	}
}

func FuzzReadHello(f *testing.F) {
	f.Add(handshake(773, "survival.mc.example.com", 25565, 2))
	f.Add(handshake(47, "mc.example.com\x00FML\x00", 25565, 1))
	f.Add([]byte{0xFE, 0x01})
	f.Add([]byte{0xFF, 0xFF, 0xFF, 0x7F})
	f.Fuzz(func(t *testing.T, in []byte) {
		h, err := Minecraft{}.ReadHello(bytes.NewReader(in), 2048)
		if err != nil {
			return
		}
		if len(h.Raw) > 2048 || !bytes.Equal(h.Raw, in[:len(h.Raw)]) {
			t.Fatalf("Raw isn't a prefix of the input within the limit")
		}
		if NormaliseHostname(h.Hostname) != h.Hostname {
			t.Fatalf("hostname %q isn't normalised", h.Hostname)
		}
	})
}
