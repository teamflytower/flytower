// Package proxyproto writes PROXY protocol version 2 headers, which tell a server the real
// address of a client whose connection came through a proxy. Paper reads them natively and
// Fabric through a mod. See https://www.haproxy.org/download/2.9/doc/proxy-protocol.txt.
package proxyproto

import (
	"encoding/binary"
	"errors"
	"net/netip"
)

var signature = []byte("\r\n\r\n\x00\r\nQUIT\n")

const (
	versionProxy = 0x21 // version 2, PROXY command
	tcp4         = 0x11
	tcp6         = 0x21
)

// Header returns the version 2 header for a TCP connection from src to dst. If one address is
// IPv4 and the other IPv6, both are sent as IPv6.
func Header(src, dst netip.AddrPort) ([]byte, error) {
	s, d := src.Addr().Unmap(), dst.Addr().Unmap()
	if !s.IsValid() || !d.IsValid() {
		return nil, errors.New("proxyproto: invalid address")
	}
	h := append(make([]byte, 0, 16+36), signature...)
	h = append(h, versionProxy)
	if s.Is4() && d.Is4() {
		h = append(h, tcp4)
		h = binary.BigEndian.AppendUint16(h, 12)
		h = append(h, s.AsSlice()...)
		h = append(h, d.AsSlice()...)
	} else {
		s16, d16 := s.As16(), d.As16()
		h = append(h, tcp6)
		h = binary.BigEndian.AppendUint16(h, 36)
		h = append(h, s16[:]...)
		h = append(h, d16[:]...)
	}
	h = binary.BigEndian.AppendUint16(h, src.Port())
	h = binary.BigEndian.AppendUint16(h, dst.Port())
	return h, nil
}
