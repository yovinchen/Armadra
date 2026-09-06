package v1_test

import (
	"math"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

// Remote execution completion, batches 4 and 5 (remote completion design §3.8).
//
// The Host does not read `request_json`: it forwards the envelope and checks
// the root and the grants. What has to survive across versions is exactly what
// is typed here — the operation numbers, the upload byte stream and the
// unsolicited watch frame — so those are the ones with shared fixtures.
func TestWorkerRemoteCompletionWire(t *testing.T) {
	for name, message := range map[string]proto.Message{
		// A repository panel read. The controller resolved the grants; the
		// Worker re-checks them, so both flags stay on the wire.
		"worker_service_branches": &pb.WorkerRequest{
			RequestId:          "branches-1",
			HostId:             "0123456789abcdef0123456789abcdef",
			ExpectedInstanceId: "abcdef0123456789abcdef0123456789",
			DeadlineUnixMs:     1788557900000,
			Action: &pb.WorkerRequest_Service{Service: &pb.WorkerServiceRequest{
				RootId:       "root-1",
				Operation:    pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_BRANCHES,
				RequestJson:  []byte(`{"path":"."}`),
				AllowExecute: true,
			}},
		},
		// Starting a queued Git operation is a write *and* an execution: a
		// request that carries only one of the two is refused on the host.
		"worker_service_operation_start": &pb.WorkerRequest{
			RequestId:          "queue-1",
			HostId:             "0123456789abcdef0123456789abcdef",
			ExpectedInstanceId: "abcdef0123456789abcdef0123456789",
			DeadlineUnixMs:     1788557900000,
			Action: &pb.WorkerRequest_Service{Service: &pb.WorkerServiceRequest{
				RootId:       "root-1",
				Operation:    pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_OPERATION_START,
				RequestJson:  []byte(`{"path":".","action":{"kind":"fetch"},"expected":{"head":"HEAD"}}`),
				AllowWrite:   true,
				AllowExecute: true,
			}},
		},
		// Deleting to the trash is a move under `.armadra/trash/`, and the
		// number that does it must not be confused with the read that lists it.
		"worker_service_trash": &pb.WorkerRequest{
			RequestId:          "trash-1",
			HostId:             "0123456789abcdef0123456789abcdef",
			ExpectedInstanceId: "abcdef0123456789abcdef0123456789",
			DeadlineUnixMs:     1788557900000,
			Action: &pb.WorkerRequest_Service{Service: &pb.WorkerServiceRequest{
				RootId:      "root-1",
				Operation:   pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_FILE_ENTRY_DELETE,
				RequestJson: []byte(`{"path":"文档/草稿.md"}`),
				AllowWrite:  true,
			}},
		},
		// An operation number this build has never heard of stays the number
		// it was. A Worker built after this Host must be refused as unknown,
		// not silently read as UNSPECIFIED and executed as something else.
		"worker_service_unknown_operation": &pb.WorkerResponse{
			RequestId:  "unknown-1",
			HostId:     "0123456789abcdef0123456789abcdef",
			InstanceId: "abcdef0123456789abcdef0123456789",
			Result: &pb.WorkerResponse_Service{Service: &pb.WorkerServiceResponse{
				HttpStatus:   501,
				ResponseJson: []byte(`{"code":"unsupported","message":"未知操作"}`),
			}},
		},
		// The contract version is what replaces the exact runtime_version
		// match (§3.5), so the two have to be separately representable: this
		// Worker is a different patch build that still speaks contract 1.
		"worker_hello_contract": &pb.WorkerResponse{
			RequestId:  "hello-1",
			HostId:     "0123456789abcdef0123456789abcdef",
			InstanceId: "abcdef0123456789abcdef0123456789",
			Result: &pb.WorkerResponse_Hello{Hello: &pb.WorkerHelloResponse{
				Protocol:               &pb.ProtocolVersion{Major: 1},
				HostId:                 "0123456789abcdef0123456789abcdef",
				InstanceId:             "abcdef0123456789abcdef0123456789",
				Platform:               "linux",
				Architecture:           "aarch64",
				Capabilities:           []string{"remote.execution.v1", "remote.git.panel.v1", "remote.files.manage.v1", "remote.upload.v1", "remote.watch.v1"},
				MaxFrameBytes:          1 << 20,
				MaxFileChunkBytes:      256 << 10,
				MaxTextFileBytes:       1 << 20,
				RuntimeVersion:         "0.1.1",
				ServiceContractVersion: 1,
			}},
		},
		// Subscribing names the paths; unsubscribing names them too, because a
		// root can have more than one editor open and closing one must not
		// blind the others.
		"worker_watch_subscribe": &pb.WorkerRequest{
			RequestId:          "watch-1",
			HostId:             "0123456789abcdef0123456789abcdef",
			ExpectedInstanceId: "abcdef0123456789abcdef0123456789",
			DeadlineUnixMs:     1788557900000,
			Action: &pb.WorkerRequest_Watch{Watch: &pb.WorkerWatchRequest{
				RootId:    "root-1",
				Operation: pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_WATCH_SUBSCRIBE,
				Paths:     []string{"README.md", "文档/草稿.md"},
			}},
		},
		"worker_watch_receipt": &pb.WorkerResponse{
			RequestId:  "watch-1",
			HostId:     "0123456789abcdef0123456789abcdef",
			InstanceId: "abcdef0123456789abcdef0123456789",
			Result: &pb.WorkerResponse_Watch{Watch: &pb.WorkerWatchSubscription{
				RootId:       "root-1",
				WatchedPaths: 2,
				Sequence:     1,
			}},
		},
		// The unsolicited frame. An empty request_id is the whole signal that
		// this is not an answer, so it has to be encodable as empty and it has
		// to stay distinguishable from an answer to request "".
		"worker_watch_event": &pb.WorkerResponse{
			HostId:     "0123456789abcdef0123456789abcdef",
			InstanceId: "abcdef0123456789abcdef0123456789",
			Result: &pb.WorkerResponse_WatchEvent{WatchEvent: &pb.WorkerWatchEvent{
				RootId:   "root-1",
				Sequence: 9007199254740993,
				Changes: []*pb.WorkerWatchChange{
					{Path: "README.md", Kind: "modified", Sha256: "abc", Size: 12, Mtime: "2026-09-06T00:00:00Z"},
					// A removal has no digest, size or mtime to report.
					{Path: "文档/草稿.md", Kind: "removed"},
				},
			}},
		},
		// Upload: begin carries the whole-file digest so a Worker can refuse
		// at the end rather than publish bytes nobody vouched for.
		"worker_upload_begin": &pb.WorkerRequest{
			RequestId:          "upload-1",
			HostId:             "0123456789abcdef0123456789abcdef",
			ExpectedInstanceId: "abcdef0123456789abcdef0123456789",
			DeadlineUnixMs:     1788557900000,
			Action: &pb.WorkerRequest_Upload{Upload: &pb.WorkerUploadRequest{
				Step: &pb.WorkerUploadRequest_Begin{Begin: &pb.WorkerUploadBegin{
					RootId:          "root-1",
					Path:            ".armadra/assets/图片.png",
					TotalBytes:      3145728,
					Sha256:          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
					OverwriteSha256: proto.String("fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"),
					AllowWrite:      true,
				}},
			}},
		},
		// A create-only begin leaves overwrite_sha256 absent. Absent and
		// present-but-empty must not collapse into each other: one refuses an
		// existing file, the other would claim it had an empty version.
		"worker_upload_begin_new": &pb.WorkerRequest{
			RequestId:          "upload-2",
			HostId:             "0123456789abcdef0123456789abcdef",
			ExpectedInstanceId: "abcdef0123456789abcdef0123456789",
			DeadlineUnixMs:     1788557900000,
			Action: &pb.WorkerRequest_Upload{Upload: &pb.WorkerUploadRequest{
				Step: &pb.WorkerUploadRequest_Begin{Begin: &pb.WorkerUploadBegin{
					RootId:     "root-1",
					Path:       "new.bin",
					TotalBytes: 0,
					Sha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
					AllowWrite: true,
				}},
			}},
		},
		"worker_upload_chunk": &pb.WorkerRequest{
			RequestId:          "upload-3",
			HostId:             "0123456789abcdef0123456789abcdef",
			ExpectedInstanceId: "abcdef0123456789abcdef0123456789",
			DeadlineUnixMs:     1788557900000,
			Action: &pb.WorkerRequest_Upload{Upload: &pb.WorkerUploadRequest{
				Step: &pb.WorkerUploadRequest_Chunk{Chunk: &pb.WorkerUploadChunk{
					UploadId: "u-0123456789abcdef",
					Offset:   math.MaxUint32,
					Data:     []byte{0, 255, 27, 10},
				}},
			}},
		},
		"worker_upload_commit": &pb.WorkerRequest{
			RequestId:          "upload-4",
			HostId:             "0123456789abcdef0123456789abcdef",
			ExpectedInstanceId: "abcdef0123456789abcdef0123456789",
			DeadlineUnixMs:     1788557900000,
			Action: &pb.WorkerRequest_Upload{Upload: &pb.WorkerUploadRequest{
				Step: &pb.WorkerUploadRequest_Commit{Commit: &pb.WorkerUploadCommit{UploadId: "u-0123456789abcdef"}},
			}},
		},
		"worker_upload_abort": &pb.WorkerRequest{
			RequestId:          "upload-5",
			HostId:             "0123456789abcdef0123456789abcdef",
			ExpectedInstanceId: "abcdef0123456789abcdef0123456789",
			DeadlineUnixMs:     1788557900000,
			Action: &pb.WorkerRequest_Upload{Upload: &pb.WorkerUploadRequest{
				Step: &pb.WorkerUploadRequest_Abort{Abort: &pb.WorkerUploadAbort{UploadId: "u-0123456789abcdef"}},
			}},
		},
		"worker_upload_receipt": &pb.WorkerResponse{
			RequestId:  "upload-4",
			HostId:     "0123456789abcdef0123456789abcdef",
			InstanceId: "abcdef0123456789abcdef0123456789",
			Result: &pb.WorkerResponse_Upload{Upload: &pb.WorkerUploadResponse{
				UploadId:      "u-0123456789abcdef",
				ReceivedBytes: 3145728,
				Sha256:        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				Path:          ".armadra/assets/图片.png",
			}},
		},
	} {
		encoded, err := proto.Marshal(message)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		wire := fixture(t, name, encoded)
		decoded := message.ProtoReflect().New().Interface()
		if err := proto.Unmarshal(wire, decoded); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !proto.Equal(decoded, message) {
			t.Fatalf("%s does not round-trip", name)
		}
	}
}

// The numbers are the contract; a renamed constant that moved would be a
// silently different operation on the other machine.
func TestWorkerServiceOperationNumbersAreFrozen(t *testing.T) {
	for operation, number := range map[pb.WorkerServiceOperation]int32{
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_REPOSITORIES:        19,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_BRANCHES:            20,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_HISTORY:             21,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_COMMIT_DETAIL:       22,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_COMMIT_FILE_DIFF:    23,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_WORKTREES:           24,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_REBASE_TODO:         25,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_TAGS:                26,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_REMOTES:             27,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_STASHES:             28,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_STASH_DETAIL:        29,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_INTEGRATION:         30,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_CHERRY_PICK_PREVIEW: 31,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_HUNKS:               32,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_MESSAGE_SOURCE:      33,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_OPERATIONS:          34,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_OPERATION_GET:       35,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_OPERATION_START:     36,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_OPERATION_CANCEL:    37,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_GIT_APPLY_HUNK:          38,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_FILE_ENTRY_TRASH_LIST:   39,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_FILE_INFO:               40,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_FILE_ENTRY_CREATE:       41,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_FILE_ENTRY_RENAME:       42,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_FILE_ENTRY_MOVE:         43,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_FILE_ENTRY_DELETE:       44,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_FILE_ENTRY_RESTORE:      45,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_ASSET_IMPORT:            46,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_WATCH_SUBSCRIBE:         47,
		pb.WorkerServiceOperation_WORKER_SERVICE_OPERATION_WATCH_UNSUBSCRIBE:       48,
	} {
		if int32(operation) != number {
			t.Fatalf("%v is %d, expected %d", operation, int32(operation), number)
		}
	}
}

// An unsolicited frame is exactly "a response with no request_id". If an empty
// request_id ever started being serialized, a controller's demultiplexer would
// see a reply to a request nobody made.
func TestAWatchEventCarriesNoRequestId(t *testing.T) {
	encoded, err := proto.Marshal(&pb.WorkerResponse{
		InstanceId: "abcdef0123456789abcdef0123456789",
		Result: &pb.WorkerResponse_WatchEvent{WatchEvent: &pb.WorkerWatchEvent{
			RootId: "root-1", Sequence: 1,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var decoded pb.WorkerResponse
	if err := proto.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.GetRequestId() != "" {
		t.Fatalf("watch events must not carry a request id, got %q", decoded.GetRequestId())
	}
	for rest := encoded; len(rest) > 0; {
		number, kind, tag := protowire.ConsumeTag(rest)
		if tag < 0 {
			t.Fatal("the frame is not valid protobuf")
		}
		if number == 1 {
			t.Fatal("field 1 was serialized on a frame that has no request id")
		}
		value := protowire.ConsumeFieldValue(number, kind, rest[tag:])
		if value < 0 {
			t.Fatal("the frame is not valid protobuf")
		}
		rest = rest[tag+value:]
	}
}
