package server

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/canvashost"
	"armadra.local/host/internal/eventstream"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

func withEvents(f *authFixture, options *Options) {
	hub, err := eventstream.New(eventstream.Options{
		Store:      f.store,
		HostID:     authHost,
		Projectors: []eventstream.Projector{canvashost.EventProjector{}},
	})
	if err != nil {
		panic(err)
	}
	f.store.SetCommitNotifier(hub.Notify)
	options.Events = hub
}

// upgrade performs a real WebSocket handshake against the authenticated HTTPS
// surface. It is deliberately raw: the point of these tests is what the Host
// does with the handshake a browser actually sends, including the credentials
// a browser cannot omit and the header it cannot add.
func upgrade(t *testing.T, f *authFixture, origin string, cookies []*http.Cookie, extra map[string]string) (*bufio.Reader, *tls.Conn, *http.Response) {
	t.Helper()
	transport, ok := f.server.Client().Transport.(*http.Transport)
	if !ok {
		t.Fatal("fixture client has no TLS transport")
	}
	address := f.server.Listener.Addr().String()
	conn, err := tls.Dial("tcp", address, transport.TLSClientConfig.Clone())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	key := base64.StdEncoding.EncodeToString(nonce[:])
	lines := []string{
		"GET " + EventStreamPath + " HTTP/1.1",
		"Host: " + address,
		"Upgrade: websocket",
		"Connection: Upgrade",
		"Sec-WebSocket-Version: 13",
		"Sec-WebSocket-Key: " + key,
		"Sec-Fetch-Site: same-origin",
	}
	if origin != "" {
		lines = append(lines, "Origin: "+origin)
	}
	if len(cookies) > 0 {
		parts := make([]string, 0, len(cookies))
		for _, cookie := range cookies {
			parts = append(parts, cookie.Name+"="+cookie.Value)
		}
		lines = append(lines, "Cookie: "+strings.Join(parts, "; "))
	}
	for name, value := range extra {
		replaced := false
		for index, line := range lines {
			if strings.HasPrefix(line, name+":") {
				lines[index] = name + ": " + value
				replaced = true
				break
			}
		}
		if !replaced {
			lines = append(lines, name+": "+value)
		}
	}
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	if _, err = io.WriteString(conn, strings.Join(lines, "\r\n")+"\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode == http.StatusSwitchingProtocols {
		sum := sha1.Sum([]byte(key + eventStreamGUID))
		if response.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(sum[:]) {
			t.Fatal("the upgrade did not prove it read the handshake key")
		}
	}
	return reader, conn, response
}

// The GUID RFC 6455 mixes into the accept token. Repeated here so the test
// verifies the Host's answer independently of the Host's own constant.
const eventStreamGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

func mustURL(t *testing.T, value string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func writeStreamFrame(t *testing.T, conn *tls.Conn, frame *pb.EventStreamFrame) {
	t.Helper()
	payload, err := proto.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	header := []byte{0x82}
	switch {
	case len(payload) < 126:
		header = append(header, 0x80|byte(len(payload)))
	default:
		header = append(header, 0x80|126, 0, 0)
		binary.BigEndian.PutUint16(header[2:], uint16(len(payload)))
	}
	var mask [4]byte
	if _, err = rand.Read(mask[:]); err != nil {
		t.Fatal(err)
	}
	header = append(header, mask[:]...)
	body := append([]byte(nil), payload...)
	for index := range body {
		body[index] ^= mask[index%4]
	}
	if _, err = conn.Write(append(header, body...)); err != nil {
		t.Fatal(err)
	}
}

func readStreamFrame(t *testing.T, reader *bufio.Reader, conn *tls.Conn) *pb.EventStreamFrame {
	t.Helper()
	for {
		_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		var header [2]byte
		if _, err := io.ReadFull(reader, header[:]); err != nil {
			t.Fatal(err)
		}
		length := int64(header[1] & 0x7f)
		if length == 126 {
			var extended [2]byte
			if _, err := io.ReadFull(reader, extended[:]); err != nil {
				t.Fatal(err)
			}
			length = int64(binary.BigEndian.Uint16(extended[:]))
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(reader, payload); err != nil {
			t.Fatal(err)
		}
		if opcode := header[0] & 0x0f; opcode != 0x2 {
			// Pings and closes are not what these tests assert about.
			if opcode == 0x8 {
				t.Fatal("the Host closed the stream")
			}
			continue
		}
		frame := &pb.EventStreamFrame{}
		if err := proto.Unmarshal(payload, frame); err != nil {
			t.Fatal(err)
		}
		return frame
	}
}

// A Host that assembles no stream must answer NOT_FOUND rather than accepting
// an upgrade it will never send anything on. A client that saw a silent open
// socket would stop polling and then stop learning about changes entirely.
func TestEventStreamIsNotFoundWithoutAHub(t *testing.T) {
	f := newAuthFixture(t)
	client := f.client(t)
	f.pair(t, client, "浏览器", auth.AllScopes())
	_, _, response := upgrade(t, f, f.origin, client.Jar.Cookies(mustURL(t, f.origin)), nil)
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("a Host with no stream answered %d", response.StatusCode)
	}
}

// A stream is a long-lived grant. It is refused before the upgrade for an
// unauthenticated device, for a foreign origin, and for a method that is not
// the handshake — each of which is a different way in.
func TestEventStreamRefusesUnauthenticatedForeignAndNonHandshakeRequests(t *testing.T) {
	f := newAuthFixture(t, withEvents)
	client := f.client(t)
	f.pair(t, client, "浏览器", auth.AllScopes())
	cookies := client.Jar.Cookies(mustURL(t, f.origin))

	t.Run("no session cookie", func(t *testing.T) {
		_, _, response := upgrade(t, f, f.origin, nil, nil)
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("an unauthenticated upgrade answered %d", response.StatusCode)
		}
	})
	t.Run("foreign origin", func(t *testing.T) {
		_, _, response := upgrade(t, f, "https://evil.example", cookies, nil)
		if response.StatusCode != http.StatusForbidden {
			t.Fatalf("a cross-origin upgrade answered %d", response.StatusCode)
		}
	})
	t.Run("cross-site fetch metadata", func(t *testing.T) {
		_, _, response := upgrade(t, f, f.origin, cookies, map[string]string{"Sec-Fetch-Site": "cross-site"})
		if response.StatusCode != http.StatusForbidden {
			t.Fatalf("a cross-site upgrade answered %d", response.StatusCode)
		}
	})
	t.Run("not a handshake", func(t *testing.T) {
		request, err := http.NewRequest("POST", f.origin+EventStreamPath, strings.NewReader(""))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Origin", f.origin)
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusBadRequest && response.StatusCode != http.StatusMethodNotAllowed {
			t.Fatalf("a plain POST to the stream answered %d", response.StatusCode)
		}
	})
}

// The end-to-end shape: a paired browser upgrades with nothing but its cookie
// and its origin — a handshake cannot carry a CSRF header — subscribes, and is
// pushed a canvas change written after it connected.
func TestEventStreamDeliversCanvasChangesToAPairedBrowser(t *testing.T) {
	f := newAuthFixture(t, withCanvas, withEvents)
	client := f.client(t)
	f.pair(t, client, "浏览器", auth.AllScopes())
	reader, conn, response := upgrade(t, f, f.origin, client.Jar.Cookies(mustURL(t, f.origin)), nil)
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("a paired browser was refused the stream: %d", response.StatusCode)
	}
	writeStreamFrame(t, conn, &pb.EventStreamFrame{Payload: &pb.EventStreamFrame_Subscribe{
		Subscribe: &pb.SubscribeEventsRequest{WorkspaceIds: []string{"workspace"}},
	}})
	// Written after the subscription, so this is the push path rather than
	// catch-up: what a second browser sees when the first one saves.
	if _, err := f.store.Apply(t.Context(), "stream/workspace/1", []storage.Change{{
		Key:     storage.Key{WorkspaceID: "workspace", Kind: canvashost.KindNode, ID: "canvas-1/node-1"},
		Payload: nil,
	}}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		page := readStreamFrame(t, reader, conn).GetPage()
		if page == nil {
			continue
		}
		if page.Status != pb.EventCursorStatus_EVENT_CURSOR_STATUS_OK {
			t.Fatalf("the stream answered %v", page.Status)
		}
		for _, event := range page.Events {
			if event.Domain != pb.EventDomain_EVENT_DOMAIN_CANVAS || event.Kind != "node" {
				t.Fatalf("unexpected envelope %v/%s", event.Domain, event.Kind)
			}
			if event.EntityId != "node-1" || event.WorkspaceId != "workspace" {
				t.Fatalf("the envelope named %s in %s", event.EntityId, event.WorkspaceId)
			}
			return
		}
	}
	t.Fatal("a committed canvas change never reached the subscribed browser")
}
