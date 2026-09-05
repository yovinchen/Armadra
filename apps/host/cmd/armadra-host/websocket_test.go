package main

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// A minimal RFC 6455 client. The Host has no WebSocket dependency of its own —
// it splices bytes — so the end-to-end test brings the smallest client that can
// prove a real browser stream survives the proxy: a handshake, masked text
// frames out, unmasked frames in.
type testSocket struct {
	conn   net.Conn
	reader *bufio.Reader
}

func dialTestSocket(address, path, origin string, config *tls.Config, cookies []*http.Cookie) (*testSocket, error) {
	conn, err := tls.Dial("tcp", address, config)
	if err != nil {
		return nil, err
	}
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		conn.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(nonce[:])
	authority := strings.TrimPrefix(origin, "https://")
	header := []string{
		"GET " + path + " HTTP/1.1",
		"Host: " + authority,
		"Upgrade: websocket",
		"Connection: Upgrade",
		"Sec-WebSocket-Version: 13",
		"Sec-WebSocket-Key: " + key,
		"Origin: " + origin,
		"Sec-Fetch-Site: same-origin",
	}
	if len(cookies) > 0 {
		parts := make([]string, 0, len(cookies))
		for _, cookie := range cookies {
			parts = append(parts, cookie.Name+"="+cookie.Value)
		}
		header = append(header, "Cookie: "+strings.Join(parts, "; "))
	}
	if err = conn.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		conn.Close()
		return nil, err
	}
	if _, err = io.WriteString(conn, strings.Join(header, "\r\n")+"\r\n\r\n"); err != nil {
		conn.Close()
		return nil, err
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		conn.Close()
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusSwitchingProtocols {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		conn.Close()
		return nil, fmt.Errorf("websocket handshake answered %d: %q", response.StatusCode, detail)
	}
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	if response.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(sum[:]) {
		conn.Close()
		return nil, errors.New("websocket accept token did not match")
	}
	return &testSocket{conn: conn, reader: reader}, nil
}

func (s *testSocket) Close() { s.conn.Close() }

func (s *testSocket) writeText(payload string) error {
	if err := s.conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	body := []byte(payload)
	frame := []byte{0x81}
	switch {
	case len(body) < 126:
		frame = append(frame, byte(0x80|len(body)))
	case len(body) < 1<<16:
		frame = append(frame, 0x80|126, 0, 0)
		binary.BigEndian.PutUint16(frame[2:], uint16(len(body)))
	default:
		return errors.New("test frames stay small")
	}
	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		return err
	}
	frame = append(frame, mask[:]...)
	for index, value := range body {
		frame = append(frame, value^mask[index%4])
	}
	_, err := s.conn.Write(frame)
	return err
}

// readText returns the next text frame, skipping pings and continuation-free
// control frames. Fragmentation is not expected from this server.
func (s *testSocket) readText(deadline time.Time) (string, error) {
	for {
		if err := s.conn.SetReadDeadline(deadline); err != nil {
			return "", err
		}
		head := make([]byte, 2)
		if _, err := io.ReadFull(s.reader, head); err != nil {
			return "", err
		}
		opcode := head[0] & 0x0f
		masked := head[1]&0x80 != 0
		length := int(head[1] & 0x7f)
		switch length {
		case 126:
			extended := make([]byte, 2)
			if _, err := io.ReadFull(s.reader, extended); err != nil {
				return "", err
			}
			length = int(binary.BigEndian.Uint16(extended))
		case 127:
			extended := make([]byte, 8)
			if _, err := io.ReadFull(s.reader, extended); err != nil {
				return "", err
			}
			length = int(binary.BigEndian.Uint64(extended))
		}
		var mask [4]byte
		if masked {
			if _, err := io.ReadFull(s.reader, mask[:]); err != nil {
				return "", err
			}
		}
		body := make([]byte, length)
		if _, err := io.ReadFull(s.reader, body); err != nil {
			return "", err
		}
		if masked {
			for index := range body {
				body[index] ^= mask[index%4]
			}
		}
		switch opcode {
		case 0x1:
			return string(body), nil
		case 0x8:
			return "", io.EOF
		default:
		}
	}
}
