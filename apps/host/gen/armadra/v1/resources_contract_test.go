package v1_test

import (
	pb "armadra.local/host/gen/armadra/v1"
	"math"
	"testing"

	"google.golang.org/protobuf/proto"
)

// Resource sampling has one contract that is easy to lose in a refactor: an
// unmeasurable metric is *absent*, and an absent metric is not zero. These
// fixtures pin both halves — a measured 0% CPU and an unmeasured one must not
// encode to the same bytes.
func TestResourceMetricsWire(t *testing.T) {
	for name, message := range map[string]proto.Message{
		"resources_session": &pb.SessionMetrics{
			SessionId:       "会话-1",
			Generation:      math.MaxUint64,
			Pid:             proto.Int64(4242),
			RssBytes:        proto.Uint64(9007199254740993),
			CpuPercent:      proto.Float64(0),
			ChildCount:      proto.Uint32(2),
			Cwd:             "/工作区/项目",
			AgentId:         "claude",
			SampledAtUnixMs: 1788557000000,
			Location:        pb.ResourceLocation_RESOURCE_LOCATION_LOCAL,
			StartTimeUnixMs: proto.Int64(1788556300000),
			Children: []*pb.ProcessSample{
				{
					Identity:   &pb.ProcessIdentity{Pid: 4243, StartTimeUnixMs: proto.Int64(1788556301000)},
					Name:       "node",
					RssBytes:   proto.Uint64(1048576),
					CpuPercent: proto.Float64(12.5),
					ParentPid:  proto.Int64(4242),
				},
				{Identity: &pb.ProcessIdentity{Pid: 4244}, Name: "rg"},
			},
		},
		"resources_session_unknown": &pb.SessionMetrics{
			SessionId:       "会话-2",
			Generation:      1,
			Cwd:             "/tmp",
			SampledAtUnixMs: 1788557000000,
			Location:        pb.ResourceLocation_RESOURCE_LOCATION_REMOTE,
			UnknownReason:   pb.ResourceUnknownReason_RESOURCE_UNKNOWN_REASON_REMOTE,
		},
		"resources_host": &pb.HostMetrics{
			HostId:          "local",
			Location:        pb.ResourceLocation_RESOURCE_LOCATION_LOCAL,
			Platform:        "macos",
			CpuCores:        proto.Uint32(10),
			Memory:          &pb.MemoryMetrics{TotalBytes: proto.Uint64(68719476736), UsedBytes: proto.Uint64(9007199254740993)},
			UptimeSeconds:   proto.Uint64(0),
			SampledAtUnixMs: 1788557000000,
		},
		"resources_component": &pb.PlatformComponentMetrics{
			Kind: pb.PlatformComponentKind_PLATFORM_COMPONENT_KIND_COMMAND_WORKER,
			Process: &pb.ProcessSample{
				Identity: &pb.ProcessIdentity{Pid: math.MaxInt64, StartTimeUnixMs: proto.Int64(1788556300000)},
				Name:     "armadra-runtime",
				RssBytes: proto.Uint64(33554432),
			},
			Tree:       true,
			ChildCount: proto.Uint32(0),
		},
		"resources_subscribe": &pb.SubscribeResourcesRequest{
			WorkspaceId: "workspace-1",
			IntervalMs:  proto.Uint64(30000),
		},
	} {
		data, err := proto.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		wire := fixture(t, name, data)
		decoded := message.ProtoReflect().New().Interface()
		if err = proto.Unmarshal(wire, decoded); err != nil || !proto.Equal(decoded, message) {
			t.Fatalf("%s changed", name)
		}
	}
}

// A metric that was measured as zero and one that could not be measured are
// different statements, and they must stay different on the wire.
func TestResourceZeroIsNotUnknown(t *testing.T) {
	measured, err := proto.Marshal(&pb.ProcessSample{Identity: &pb.ProcessIdentity{Pid: 1}, CpuPercent: proto.Float64(0)})
	if err != nil {
		t.Fatal(err)
	}
	unknown, err := proto.Marshal(&pb.ProcessSample{Identity: &pb.ProcessIdentity{Pid: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if len(measured) == len(unknown) {
		t.Fatal("a measured zero encodes like an absent metric")
	}
	var back pb.ProcessSample
	if err = proto.Unmarshal(unknown, &back); err != nil || back.CpuPercent != nil {
		t.Fatal("an absent metric decoded as a value")
	}
}

// Every enumeration reserves 0 for UNSPECIFIED, so a default-constructed
// message never claims to be a real location, reason or component.
func TestResourceEnumsReserveZero(t *testing.T) {
	if pb.ResourceLocation_RESOURCE_LOCATION_UNSPECIFIED != 0 ||
		pb.ResourceUnknownReason_RESOURCE_UNKNOWN_REASON_UNSPECIFIED != 0 ||
		pb.PlatformComponentKind_PLATFORM_COMPONENT_KIND_UNSPECIFIED != 0 {
		t.Fatal("a resource enumeration gives 0 a meaning")
	}
}
