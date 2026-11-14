package handshake

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

// Minecraft is the Java Edition handshake, from 1.7 onwards.
type Minecraft struct {
	// ServerName is shown as the version in the server list for answered pings.
	ServerName string
}

// Name implements Protocol.
func (Minecraft) Name() string { return "minecraft" }

// maxHostnameChars is the most the vanilla server accepts for the address field.
const maxHostnameChars = 255

// ReadHello implements Protocol. A handshake is one packet: a VarInt length, then packet id 0,
// a VarInt protocol version, the address as a string, the port as a big-endian uint16 and a
// VarInt next state (1 status, 2 login, 3 transfer).
func (Minecraft) ReadHello(r io.Reader, limit int) (*Hello, error) {
	raw := make([]byte, 0, 64)
	var one [1]byte
	// The length prefix, one byte at a time, so nothing past the handshake is read.
	var length int
	for i := 0; ; i++ {
		if _, err := io.ReadFull(r, one[:]); err != nil {
			return nil, err
		}
		b := one[0]
		raw = append(raw, b)
		if i == 0 && b == 0xFE {
			return nil, ErrLegacy
		}
		length |= int(b&0x7F) << (7 * i)
		if b&0x80 == 0 {
			break
		}
		if i >= 2 { // three bytes is up to 2 MiB, far beyond any limit
			return nil, ErrTooLarge
		}
	}
	if length < 1 {
		return nil, ErrMalformed
	}
	if len(raw)+length > limit {
		return nil, ErrTooLarge
	}
	start := len(raw)
	raw = append(raw, make([]byte, length)...)
	if _, err := io.ReadFull(r, raw[start:]); err != nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		return nil, err
	}
	body := bytes.NewReader(raw[start:])

	id, err := readVarInt(body)
	if err != nil || id != 0 {
		return nil, ErrMalformed
	}
	version, err := readVarInt(body)
	if err != nil {
		return nil, ErrMalformed
	}
	host, err := readString(body, maxHostnameChars*4+256)
	if err != nil {
		return nil, ErrMalformed
	}
	var port uint16
	if err := binary.Read(body, binary.BigEndian, &port); err != nil {
		return nil, ErrMalformed
	}
	next, err := readVarInt(body)
	if err != nil || body.Len() != 0 {
		return nil, ErrMalformed
	}
	var intent Intent
	switch next {
	case 1:
		intent = Status
	case 2, 3: // 3 is a transfer from another server (1.20.5+), which is a login too
		intent = Login
	default:
		return nil, ErrMalformed
	}
	return &Hello{
		Hostname:    NormaliseHostname(host),
		RawHostname: host,
		Port:        port,
		Version:     version,
		Intent:      intent,
		Raw:         raw,
	}, nil
}

// NormaliseHostname turns the address a client sent into the one to look up. It drops
// anything from the first NUL (Forge adds "\x00FML\x00", "\x00FML2\x00" or "\x00FML3\x00", and
// some proxies append forwarding data the same way), a port if one slipped in and trailing dots
// (a fully qualified name typed by the player), then lower-cases the rest.
func NormaliseHostname(host string) string {
	if i := strings.IndexByte(host, 0); i >= 0 {
		host = host[:i]
	}
	if i := strings.LastIndexByte(host, ':'); i >= 0 && !strings.Contains(host[:i], ":") {
		host = host[:i]
	}
	return strings.ToLower(strings.TrimRight(host, "."))
}

// Answer implements Protocol.
func (m Minecraft) Answer(rw io.ReadWriter, h *Hello, a Answer) error {
	if h.Intent == Status {
		return m.answerStatus(rw, h, a.MOTD)
	}
	return answerLogin(rw, a.Disconnect)
}

// answerStatus waits for the status request, sends the server-list entry, then answers the
// ping that follows so the client shows a latency rather than an error.
func (m Minecraft) answerStatus(rw io.ReadWriter, h *Hello, motd string) error {
	if id, _, err := readPacket(rw, 16); err != nil || id != 0x00 {
		return ErrMalformed
	}
	name := m.ServerName
	if name == "" {
		name = "Flytower"
	}
	status, _ := json.Marshal(map[string]any{
		"version":     map[string]any{"name": name, "protocol": h.Version},
		"players":     map[string]int{"max": 0, "online": 0},
		"description": map[string]string{"text": motd},
	})
	if err := writePacket(rw, 0x00, appendString(nil, string(status))); err != nil {
		return err
	}
	id, payload, err := readPacket(rw, 16)
	if err != nil {
		return nil // the client may close without pinging
	}
	if id != 0x01 || len(payload) != 8 {
		return ErrMalformed
	}
	return writePacket(rw, 0x01, payload)
}

// answerLogin waits for the login start packet, so the client is listening, then sends the
// disconnect screen. The reason is a text component encoded as a JSON string.
func answerLogin(rw io.ReadWriter, message string) error {
	if _, _, err := readPacket(rw, 1024); err != nil {
		return err
	}
	reason, _ := json.Marshal(map[string]string{"text": message})
	return writePacket(rw, 0x00, appendString(nil, string(reason)))
}

func readVarInt(r io.ByteReader) (int32, error) {
	var v uint32
	for i := 0; i < 5; i++ {
		b, err := r.ReadByte()
		if err != nil {
			return 0, err
		}
		v |= uint32(b&0x7F) << (7 * i)
		if b&0x80 == 0 {
			return int32(v), nil
		}
	}
	return 0, ErrMalformed
}

func appendVarInt(b []byte, v int32) []byte {
	u := uint32(v)
	for u >= 0x80 {
		b = append(b, byte(u)|0x80)
		u >>= 7
	}
	return append(b, byte(u))
}

func readString(r *bytes.Reader, maxBytes int) (string, error) {
	n, err := readVarInt(r)
	if err != nil || n < 0 || int(n) > maxBytes || int(n) > r.Len() {
		return "", ErrMalformed
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return "", ErrMalformed
	}
	if !utf8.Valid(buf) || utf8.RuneCount(buf) > maxHostnameChars+64 {
		return "", ErrMalformed
	}
	return string(buf), nil
}

func appendString(b []byte, s string) []byte {
	return append(appendVarInt(b, int32(len(s))), s...)
}

// byteReader reads one byte at a time from r, so a packet's length prefix doesn't over-read.
type byteReader struct{ r io.Reader }

func (b byteReader) ReadByte() (byte, error) {
	var one [1]byte
	_, err := io.ReadFull(b.r, one[:])
	return one[0], err
}

// readPacket reads one uncompressed packet of at most limit bytes.
func readPacket(r io.Reader, limit int) (int32, []byte, error) {
	length, err := readVarInt(byteReader{r})
	if err != nil {
		return 0, nil, err
	}
	if length < 1 || int(length) > limit {
		return 0, nil, ErrTooLarge
	}
	buf := make([]byte, length)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}
	body := bytes.NewReader(buf)
	id, err := readVarInt(body)
	if err != nil {
		return 0, nil, ErrMalformed
	}
	return id, buf[len(buf)-body.Len():], nil
}

func writePacket(w io.Writer, id int32, payload []byte) error {
	body := appendVarInt(nil, id)
	body = append(body, payload...)
	out := appendVarInt(make([]byte, 0, len(body)+5), int32(len(body)))
	out = append(out, body...)
	_, err := w.Write(out)
	if err != nil {
		return fmt.Errorf("write packet: %w", err)
	}
	return nil
}
