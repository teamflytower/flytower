//go:build !linux

package router

func isFDExhausted(error) bool { return false }
