//go:build !linux

package control

import (
	"errors"
	"net"
)

func peerUID(*net.UnixConn) (uint32, error) {
	return 0, errors.New("peer credentials need Linux")
}
