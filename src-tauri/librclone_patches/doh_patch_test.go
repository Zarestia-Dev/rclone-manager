package main

import (
	"io"
	"net/http"
	"testing"
)

func TestDohConnWriteShort(t *testing.T) {
	conn := &dohConn{client: http.DefaultClient}
	_, err := conn.Write([]byte{0x00})
	if err != io.ErrShortWrite {
		t.Errorf("expected io.ErrShortWrite for short slice, got %v", err)
	}
}
