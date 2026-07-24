package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"runtime"
	"time"
)

func init() {
	if runtime.GOOS == "android" {
		httpClient := &http.Client{Timeout: 3 * time.Second}
		net.DefaultResolver = &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				return &dohConn{client: httpClient}, nil
			},
		}
	}
}

// dohQuery sends a single DNS wire-format query to the given DoH endpoint
// and returns the raw wire-format response.
func dohQuery(client *http.Client, endpoint string, query []byte) ([]byte, error) {
	req, err := http.NewRequest("POST", endpoint, bytes.NewReader(query))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/dns-message")
	req.Header.Set("Accept", "application/dns-message")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("DoH status: %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// dohConn implements net.Conn by tunnelling DNS queries over HTTPS (DoH).
// This bypasses Android's SELinux restriction on raw UDP/TCP port 53 sockets.
// Go's stream resolver always sends a 2-byte length prefix and expects one back.
type dohConn struct {
	buf    bytes.Buffer
	client *http.Client
}

func (c *dohConn) Write(b []byte) (int, error) {
	if len(b) < 2 {
		return 0, io.ErrShortWrite
	}
	// b[0:2] is the TCP-stream length prefix added by Go's resolver; strip it.
	query := b[2:]

	body, err := dohQuery(c.client, "https://1.1.1.1/dns-query", query)
	if err != nil {
		body, err = dohQuery(c.client, "https://8.8.8.8/dns-query", query)
		if err != nil {
			return 0, err
		}
	}

	// Re-add the 2-byte length prefix so Go's stream reader gets what it expects.
	l := len(body)
	c.buf.WriteByte(byte(l >> 8))
	c.buf.WriteByte(byte(l))
	c.buf.Write(body)
	return len(b), nil
}

func (c *dohConn) Read(b []byte) (int, error)       { return c.buf.Read(b) }
func (c *dohConn) Close() error                     { return nil }
func (c *dohConn) LocalAddr() net.Addr              { return &net.UDPAddr{} }
func (c *dohConn) RemoteAddr() net.Addr             { return &net.UDPAddr{} }
func (c *dohConn) SetDeadline(time.Time) error      { return nil }
func (c *dohConn) SetReadDeadline(time.Time) error  { return nil }
func (c *dohConn) SetWriteDeadline(time.Time) error { return nil }
