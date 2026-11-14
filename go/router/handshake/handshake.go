// Package handshake reads the first packet a game client sends, which says which hostname the
// player typed, and answers clients the router won't forward. Each game gets its own Protocol,
// so the router itself doesn't know about Minecraft.
package handshake

import (
	"errors"
	"io"
)

// Intent is what the client wants once connected.
type Intent int

const (
	// Status is a server-list ping.
	Status Intent = iota + 1
	// Login is a player joining.
	Login
)

func (i Intent) String() string {
	switch i {
	case Status:
		return "status"
	case Login:
		return "login"
	}
	return "unknown"
}

// Hello is what a client said in its handshake.
type Hello struct {
	// Hostname is the address the player typed, normalised for lookups: lower case, with no
	// trailing dot and no mod loader suffix.
	Hostname string
	// RawHostname is the hostname exactly as sent.
	RawHostname string
	Port        uint16
	// Version is the game's protocol version number.
	Version int32
	Intent  Intent
	// Raw holds every byte read so far, to replay to the server the connection goes to.
	Raw []byte
}

// Answer is what to tell a client the router won't forward.
type Answer struct {
	// MOTD is shown in the server list.
	MOTD string
	// Disconnect is shown to a player who tries to join.
	Disconnect string
}

// Protocol reads one game's handshake.
type Protocol interface {
	// Name is the game, for logs.
	Name() string
	// ReadHello reads the handshake and no further, so nothing meant for the server is lost.
	// It reads at most limit bytes.
	ReadHello(r io.Reader, limit int) (*Hello, error)
	// Answer replies to a client after its handshake: a status ping gets the MOTD, and a login
	// gets the disconnect message. The caller sets deadlines and closes the connection.
	Answer(rw io.ReadWriter, h *Hello, a Answer) error
}

var (
	// ErrTooLarge means the handshake was longer than the limit.
	ErrTooLarge = errors.New("handshake too large")
	// ErrMalformed means the bytes weren't a handshake.
	ErrMalformed = errors.New("malformed handshake")
	// ErrLegacy means a client from before Minecraft 1.7, which the router doesn't serve.
	ErrLegacy = errors.New("legacy handshake")
)
