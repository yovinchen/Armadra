package eventstream

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
	"google.golang.org/protobuf/proto"
)

const testHost = "0123456789abcdef0123456789abcdef"

// A minimal RFC 6455 client. The Host carries no WebSocket dependency, so the
// tests bring the smallest client that can prove a real browser stream works:
// a handshake, masked binary frames out, unmasked frames in.
type client struct {
	conn   net.Conn
	reader *bufio.Reader
}

func dial(t *testing.T, server *httptest.Server, headers map[string]string) (*client, *http.Response) {
	t.Helper()
	address := strings.TrimPrefix(server.URL, "http://")
	conn, err := net.DialTimeout("tcp", address, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	key := base64.StdEncoding.EncodeToString(nonce[:])
	lines := []string{
		"GET /ws/armadra.v1.EventStream HTTP/1.1",
		"Host: " + address,
		"Upgrade: websocket",
		"Connection: keep-alive, Upgrade",
		"Sec-WebSocket-Version: 13",
		"Sec-WebSocket-Key: " + key,
	}
	for name, value := range headers {
		if value == "" {
			// An empty value removes a default header, which is how the tests
			// reach the handshake failures a browser would never produce.
			for index, line := range lines {
				if strings.HasPrefix(line, name+":") {
					lines = append(lines[:index], lines[index+1:]...)
					break
				}
			}
			continue
		}
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
		sum := sha1.Sum([]byte(key + websocketGUID))
		if response.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(sum[:]) {
			t.Fatal("handshake accept token did not match")
		}
	}
	t.Cleanup(func() { conn.Close() })
	return &client{conn: conn, reader: reader}, response
}

func (c *client) writeFrame(code opcode, payload []byte, masked bool) error {
	header := []byte{0x80 | byte(code)}
	maskBit := byte(0)
	if masked {
		maskBit = 0x80
	}
	switch {
	case len(payload) < 126:
		header = append(header, maskBit|byte(len(payload)))
	case len(payload) < 1<<16:
		header = append(header, maskBit|126, 0, 0)
		binary.BigEndian.PutUint16(header[2:], uint16(len(payload)))
	default:
		header = append(header, maskBit|127, 0, 0, 0, 0, 0, 0, 0, 0)
		binary.BigEndian.PutUint64(header[2:], uint64(len(payload)))
	}
	body := append([]byte(nil), payload...)
	if masked {
		var mask [4]byte
		if _, err := rand.Read(mask[:]); err != nil {
			return err
		}
		header = append(header, mask[:]...)
		for index := range body {
			body[index] ^= mask[index%4]
		}
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, err := c.conn.Write(append(header, body...))
	return err
}

func (c *client) send(t *testing.T, frame *pb.EventStreamFrame) {
	t.Helper()
	wire, err := proto.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	if err = c.writeFrame(opBinary, wire, true); err != nil {
		t.Fatal(err)
	}
}

func (c *client) subscribe(t *testing.T, request *pb.SubscribeEventsRequest) {
	t.Helper()
	c.send(t, &pb.EventStreamFrame{Payload: &pb.EventStreamFrame_Subscribe{Subscribe: request}})
}

func (c *client) ack(t *testing.T, through uint64) {
	t.Helper()
	c.send(t, &pb.EventStreamFrame{Payload: &pb.EventStreamFrame_Ack{Ack: &pb.StreamAck{ReceivedThrough: through}}})
}

// readRaw returns the next non-ping frame the server sent.
func (c *client) readRaw(deadline time.Time) (opcode, []byte, error) {
	for {
		_ = c.conn.SetReadDeadline(deadline)
		var header [2]byte
		if _, err := io.ReadFull(c.reader, header[:]); err != nil {
			return 0, nil, err
		}
		code := opcode(header[0] & 0x0f)
		if header[1]&0x80 != 0 {
			return 0, nil, errors.New("server frames must not be masked")
		}
		length := int64(header[1] & 0x7f)
		switch length {
		case 126:
			var extended [2]byte
			if _, err := io.ReadFull(c.reader, extended[:]); err != nil {
				return 0, nil, err
			}
			length = int64(binary.BigEndian.Uint16(extended[:]))
		case 127:
			var extended [8]byte
			if _, err := io.ReadFull(c.reader, extended[:]); err != nil {
				return 0, nil, err
			}
			length = int64(binary.BigEndian.Uint64(extended[:]))
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(c.reader, payload); err != nil {
			return 0, nil, err
		}
		if code == opPing {
			if err := c.writeFrame(opPong, payload, true); err != nil {
				return 0, nil, err
			}
			continue
		}
		return code, payload, nil
	}
}

// next returns the next stream frame, or the close code when the server ended
// the stream instead.
func (c *client) next(t *testing.T, within time.Duration) (*pb.EventStreamFrame, uint16) {
	t.Helper()
	code, payload, err := c.readRaw(time.Now().Add(within))
	if err != nil {
		t.Fatalf("no frame within %s: %v", within, err)
	}
	if code == opClose {
		if len(payload) < 2 {
			return nil, CloseNormal
		}
		return nil, binary.BigEndian.Uint16(payload)
	}
	if code != opBinary {
		t.Fatalf("unexpected opcode %d", code)
	}
	frame := &pb.EventStreamFrame{}
	if err = proto.Unmarshal(payload, frame); err != nil {
		t.Fatal(err)
	}
	return frame, 0
}

// nextPage skips heartbeats, which arrive on their own schedule and are never
// what a test is asserting about.
func (c *client) nextPage(t *testing.T, within time.Duration) (*pb.EventPage, *pb.ErrorResponse, uint16) {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatal("no page within the deadline")
		}
		frame, closeCode := c.next(t, remaining)
		if frame == nil {
			return nil, nil, closeCode
		}
		if page := frame.GetPage(); page != nil {
			return page, nil, 0
		}
		if failure := frame.GetError(); failure != nil {
			return nil, failure, 0
		}
	}
}

/* ------------------------------- the fixture ------------------------------ */

type harness struct {
	t      *testing.T
	store  *storage.Store
	hub    *Hub
	server *httptest.Server
	caller Caller
	seq    int
}

func newHarness(t *testing.T, options Options, scopes []auth.Scope) *harness {
	t.Helper()
	store, err := storage.Open(t.TempDir(), testHost)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	options.Store = store
	options.HostID = testHost
	if len(options.Projectors) == 0 {
		options.Projectors = []Projector{testProjector{}}
	}
	hub, err := New(options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(hub.Close)
	store.SetCommitNotifier(hub.Notify)
	if scopes == nil {
		scopes = []auth.Scope{{Permission: "canvas:read"}}
	}
	caller := Caller{PrincipalID: "owner-1", DeviceID: "device-1", HostID: testHost, Scopes: scopes}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hub.Serve(w, r, caller)
	}))
	t.Cleanup(server.Close)
	return &harness{t: t, store: store, hub: hub, server: server, caller: caller}
}

// testProjector publishes two kinds so the tests can exercise both lanes
// without waiting for the agent domain to switch: `canvas.node` is ordinary
// canvas traffic, `agent.approval` is the question a human is blocked on.
type testProjector struct{}

func (testProjector) Domain() pb.EventDomain { return pb.EventDomain_EVENT_DOMAIN_CANVAS }

func (testProjector) Project(event storage.Event) (*pb.EventEnvelope, error) {
	domain := pb.EventDomain_EVENT_DOMAIN_CANVAS
	kind := "node"
	switch event.Kind {
	case "canvas.node":
	case "agent.approval":
		domain, kind = pb.EventDomain_EVENT_DOMAIN_AGENT, "approval"
	default:
		return nil, nil
	}
	return &pb.EventEnvelope{
		Sequence:         event.Sequence,
		TransactionId:    event.TransactionID,
		OperationId:      event.OperationID,
		TransactionIndex: uint32(event.TransactionIndex),
		TransactionSize:  uint32(event.TransactionSize),
		WorkspaceId:      event.WorkspaceID,
		Domain:           domain,
		Kind:             kind,
		EntityId:         event.ID,
		Revision:         event.Revision,
		Deleted:          event.Deleted,
	}, nil
}

// write commits one entity and returns the sequence it published.
func (h *harness) write(workspace, kind, id string, size int) uint64 {
	h.t.Helper()
	h.seq++
	payload := make([]byte, size)
	for index := range payload {
		payload[index] = byte('a' + index%26)
	}
	result, err := h.store.Apply(h.t.Context(), fmt.Sprintf("test/%s/%d", workspace, h.seq), []storage.Change{{
		Key:     storage.Key{WorkspaceID: workspace, Kind: kind, ID: id},
		Payload: payload,
	}})
	if err != nil {
		h.t.Fatal(err)
	}
	return result.LastSequence
}

/* --------------------------------- framing -------------------------------- */

// The handshake is the one place a stream can be turned into something else by
// an intermediary, so each refusal is checked rather than assumed.
func TestHandshakeRefusesWhatIsNotAWebSocket13Upgrade(t *testing.T) {
	h := newHarness(t, Options{}, nil)
	for name, headers := range map[string]map[string]string{
		"no upgrade header":  {"Upgrade": "", "Connection": "keep-alive"},
		"wrong version":      {"Sec-WebSocket-Version": "8"},
		"missing key":        {"Sec-WebSocket-Key": ""},
		"key is not 16bytes": {"Sec-WebSocket-Key": base64.StdEncoding.EncodeToString([]byte("short"))},
	} {
		t.Run(name, func(t *testing.T) {
			_, response := dial(t, h.server, headers)
			if response.StatusCode == http.StatusSwitchingProtocols {
				t.Fatal("an invalid handshake was upgraded")
			}
		})
	}
}

// A masked frame is the client's half of the contract. Accepting an unmasked
// one is what lets a cache or a transparent proxy inject a subscription.
func TestUnmaskedAndOversizedClientFramesEndTheStream(t *testing.T) {
	for name, send := range map[string]func(*client) error{
		"unmasked": func(c *client) error { return c.writeFrame(opBinary, []byte{1, 2, 3}, false) },
		"oversized": func(c *client) error {
			return c.writeFrame(opBinary, make([]byte, MaxFrameBytes+1), true)
		},
		"text instead of binary": func(c *client) error {
			return c.writeFrame(opText, []byte("subscribe"), true)
		},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, Options{}, nil)
			c, response := dial(t, h.server, nil)
			if response.StatusCode != http.StatusSwitchingProtocols {
				t.Fatal("handshake refused")
			}
			if err := send(c); err != nil {
				// A frame the server rejected mid-write is also a refusal.
				return
			}
			page, _, _ := c.nextPage(t, 5*time.Second)
			if page != nil {
				t.Fatal("a malformed frame was answered with a page")
			}
		})
	}
}

// newServerFor serves one hub with a different caller than the fixture's.
func newServerFor(t *testing.T, hub *Hub, caller Caller) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hub.Serve(w, r, caller)
	}))
	t.Cleanup(server.Close)
	return server
}
