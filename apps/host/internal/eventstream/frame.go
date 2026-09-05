// Package eventstream serves the Host's business event stream to authenticated
// browser clients (host business migration §2.3).
//
// One connection carries one subscription. The client states the sequence it
// last applied; the Host first catches it up from the stored outbox and then
// pushes what follows, so the client never has to poll and never has to guess
// whether an idle stream means "nothing changed" or "the connection died".
package eventstream

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// MaxFrameBytes bounds one WebSocket message in either direction. It matches
// the Host's protocol frame budget, so a page never becomes a message the
// client is unable to read.
const MaxFrameBytes = 1 << 20

// The fixed GUID RFC 6455 mixes into the client's key. It is not a secret; it
// exists so a cache or a proxy cannot replay a plain HTTP response as an
// accepted upgrade.
const websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type opcode byte

const (
	opContinuation opcode = 0x0
	opText         opcode = 0x1
	opBinary       opcode = 0x2
	opClose        opcode = 0x8
	opPing         opcode = 0x9
	opPong         opcode = 0xa
)

// Close codes this server sends. Each one means something a client can act on:
// a policy close is "your subscription is not allowed", an overflow close is
// "reconnect with your cursor", and a normal close is "re-subscribe when you
// have applied what I told you to apply".
const (
	CloseNormal          = 1000
	CloseProtocolError   = 1002
	ClosePolicyViolation = 1008
	CloseMessageTooBig   = 1009
	CloseInternalError   = 1011
)

var (
	// ErrClosed is returned once the peer has closed the connection cleanly.
	ErrClosed = errors.New("event stream closed")
	// ErrProtocol marks a frame this server refuses to interpret. It is never
	// softened into an empty message: a malformed frame means the peer and this
	// server disagree about the wire, and continuing would compound that.
	ErrProtocol = errors.New("event stream protocol error")
	// ErrTooLarge marks a message above the frame budget.
	ErrTooLarge = errors.New("event stream message exceeds the frame budget")
)

// socket is the minimal RFC 6455 server this Host needs: binary messages in
// both directions plus the control frames a browser and an intermediary
// require. No extension is negotiated, so a reserved bit set by the peer is an
// error rather than something to ignore.
type socket struct {
	conn     net.Conn
	reader   *bufio.Reader
	writeMu  sync.Mutex
	closeMu  sync.Mutex
	closed   bool
	sentGone bool
}

// IsUpgrade reports a WebSocket handshake. `Connection` is a comma separated
// token list, so a plain string compare would miss `keep-alive, Upgrade`.
func IsUpgrade(r *http.Request) bool {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return false
	}
	for _, value := range r.Header.Values("Connection") {
		for _, token := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
				return true
			}
		}
	}
	return false
}

// accept completes the handshake and takes the connection over. The caller has
// already authenticated the device and checked the exact browser Origin: a
// WebSocket handshake cannot carry a CSRF header, so the origin and the
// SameSite=Strict session cookie are what stand in for it.
func accept(w http.ResponseWriter, r *http.Request) (*socket, error) {
	if r.Method != http.MethodGet || !IsUpgrade(r) {
		return nil, ErrProtocol
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		return nil, ErrProtocol
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if len(r.Header.Values("Sec-WebSocket-Key")) != 1 {
		return nil, ErrProtocol
	}
	decoded, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(decoded) != 16 {
		return nil, ErrProtocol
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("this listener cannot carry a stream")
	}
	conn, buffered, err := hijacker.Hijack()
	if err != nil {
		return nil, err
	}
	// Anything pipelined behind the handshake is a frame the peer sent before
	// it saw our answer. Dropping it would lose the subscription itself.
	reader := bufio.NewReader(conn)
	if buffered != nil && buffered.Reader.Buffered() > 0 {
		reader = bufio.NewReader(io.MultiReader(io.LimitReader(buffered, int64(buffered.Reader.Buffered())), conn))
	}
	sum := sha1.Sum([]byte(key + websocketGUID))
	response := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(sum[:]) + "\r\n\r\n"
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if _, err = io.WriteString(conn, response); err != nil {
		conn.Close()
		return nil, err
	}
	_ = conn.SetWriteDeadline(time.Time{})
	return &socket{conn: conn, reader: reader}, nil
}

// read returns the next application message, answering pings itself. A control
// frame never becomes an application message, and a fragmented message is
// reassembled only up to the frame budget.
func (s *socket) read(deadline time.Time) (opcode, []byte, error) {
	var assembled []byte
	var first opcode
	fragmented := false
	for {
		if err := s.conn.SetReadDeadline(deadline); err != nil {
			return 0, nil, err
		}
		code, payload, final, err := s.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch code {
		case opPing:
			if err = s.write(opPong, payload); err != nil {
				return 0, nil, err
			}
			continue
		case opPong:
			continue
		case opClose:
			return opClose, payload, ErrClosed
		case opContinuation:
			if !fragmented {
				return 0, nil, ErrProtocol
			}
		case opText, opBinary:
			if fragmented {
				// A new data frame inside an unfinished message is not a
				// recoverable state: the two messages would be spliced.
				return 0, nil, ErrProtocol
			}
			first = code
		default:
			return 0, nil, ErrProtocol
		}
		if len(assembled)+len(payload) > MaxFrameBytes {
			return 0, nil, ErrTooLarge
		}
		assembled = append(assembled, payload...)
		if final {
			return first, assembled, nil
		}
		fragmented = true
	}
}

// readFrame reads one frame header and its payload. Client frames must be
// masked; an unmasked one is a protocol error rather than something to accept
// leniently, because leniency here is what lets a cache poison a stream.
func (s *socket) readFrame() (opcode, []byte, bool, error) {
	var header [2]byte
	if _, err := io.ReadFull(s.reader, header[:]); err != nil {
		return 0, nil, false, err
	}
	final := header[0]&0x80 != 0
	if header[0]&0x70 != 0 {
		// No extension was negotiated, so a reserved bit cannot be meaningful.
		return 0, nil, false, ErrProtocol
	}
	code := opcode(header[0] & 0x0f)
	masked := header[1]&0x80 != 0
	length := int64(header[1] & 0x7f)
	switch {
	case length == 126:
		var extended [2]byte
		if _, err := io.ReadFull(s.reader, extended[:]); err != nil {
			return 0, nil, false, err
		}
		length = int64(binary.BigEndian.Uint16(extended[:]))
		if length < 126 {
			return 0, nil, false, ErrProtocol
		}
	case length == 127:
		var extended [8]byte
		if _, err := io.ReadFull(s.reader, extended[:]); err != nil {
			return 0, nil, false, err
		}
		value := binary.BigEndian.Uint64(extended[:])
		if value > 1<<62 {
			return 0, nil, false, ErrProtocol
		}
		length = int64(value)
		if length < 1<<16 {
			return 0, nil, false, ErrProtocol
		}
	}
	if !masked {
		return 0, nil, false, ErrProtocol
	}
	if code >= opClose {
		// Control frames carry at most 125 bytes and are never fragmented.
		if !final || length > 125 {
			return 0, nil, false, ErrProtocol
		}
	}
	if length > MaxFrameBytes {
		return 0, nil, false, ErrTooLarge
	}
	var mask [4]byte
	if _, err := io.ReadFull(s.reader, mask[:]); err != nil {
		return 0, nil, false, err
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(s.reader, payload); err != nil {
		return 0, nil, false, err
	}
	for index := range payload {
		payload[index] ^= mask[index%4]
	}
	return code, payload, final, nil
}

// writeMessage sends one binary application message.
func (s *socket) writeMessage(payload []byte) error {
	if len(payload) > MaxFrameBytes {
		return ErrTooLarge
	}
	return s.write(opBinary, payload)
}

func (s *socket) ping() error { return s.write(opPing, nil) }

func (s *socket) write(code opcode, payload []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.closed {
		return net.ErrClosed
	}
	frame := make([]byte, 0, len(payload)+10)
	frame = append(frame, 0x80|byte(code))
	switch {
	case len(payload) < 126:
		frame = append(frame, byte(len(payload)))
	case len(payload) < 1<<16:
		frame = append(frame, 126, 0, 0)
		binary.BigEndian.PutUint16(frame[2:], uint16(len(payload)))
	default:
		frame = append(frame, 127, 0, 0, 0, 0, 0, 0, 0, 0)
		binary.BigEndian.PutUint64(frame[2:], uint64(len(payload)))
	}
	frame = append(frame, payload...)
	// A writer that blocks forever is a subscriber that never drains. The
	// budget already bounds how much is outstanding; this bounds how long one
	// write may take before the connection is considered gone.
	if err := s.conn.SetWriteDeadline(time.Now().Add(30 * time.Second)); err != nil {
		return err
	}
	_, err := s.conn.Write(frame)
	return err
}

// closeWith sends a close frame with a reason the client can act on, then drops
// the connection. Sending it twice is a no-op: the first reason is the true one.
func (s *socket) closeWith(code uint16, reason string) {
	s.closeMu.Lock()
	send := !s.sentGone
	s.sentGone = true
	s.closeMu.Unlock()
	if send {
		if len(reason) > 123 {
			reason = reason[:123]
		}
		payload := make([]byte, 2, 2+len(reason))
		binary.BigEndian.PutUint16(payload, code)
		payload = append(payload, reason...)
		_ = s.write(opClose, payload)
	}
	s.writeMu.Lock()
	s.closed = true
	s.writeMu.Unlock()
	_ = s.conn.Close()
}
