package router

import (
	"errors"
	"syscall"
)

func isFDExhausted(err error) bool {
	return errors.Is(err, syscall.EMFILE) || errors.Is(err, syscall.ENFILE)
}
