package automation

import (
	"fmt"
	"math"
	"strings"
	"time"
	_ "time/tzdata" // Standalone cross-platform Hosts do not depend on OS tzdata.
	"unicode/utf8"

	pb "armadra.local/host/gen/armadra/v1"
	"github.com/robfig/cron/v3"
	"google.golang.org/protobuf/proto"
)

const maxTimestampMS int64 = 253402300799999
const maxCronCount = 10000

func validText(value string, limit int, empty bool) bool {
	if (!empty && value == "") || len(value) > limit || !utf8.ValidString(value) {
		return false
	}
	for _, r := range value {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}
func validID(value string) bool {
	return validText(value, 128, false) && !strings.ContainsAny(value, "/\\ \t")
}
func validTime(value int64) bool { return value > 0 && value <= maxTimestampMS }
func cronSpec(input *pb.AutomationCron) (cron.Schedule, *time.Location, error) {
	if input == nil || len(strings.Fields(input.Expression)) != 5 || len(input.Expression) > 256 || !validText(input.Timezone, 128, false) || input.Timezone == "Local" {
		return nil, nil, ErrInvalid
	}
	location, err := time.LoadLocation(input.Timezone)
	if err != nil {
		return nil, nil, ErrInvalid
	}
	parser := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
	schedule, err := parser.Parse("CRON_TZ=" + input.Timezone + " " + input.Expression)
	if err != nil {
		return nil, nil, ErrInvalid
	}
	return schedule, location, nil
}

// Skip the second occurrence of a repeated civil minute, including 30-minute
// folds. ZoneBounds identifies the previous offset instead of assuming a fixed
// one-hour DST transition. Nonexistent local minutes are skipped by cron.Next.
func firstCivilOccurrence(value time.Time, location *time.Location) bool {
	local := value.In(location)
	start, _ := local.ZoneBounds()
	if start.IsZero() {
		return true
	}
	_, previousOffset := start.Add(-time.Nanosecond).In(location).Zone()
	civil := time.Date(local.Year(), local.Month(), local.Day(), local.Hour(), local.Minute(), local.Second(), 0, time.UTC)
	alternative := civil.Add(-time.Duration(previousOffset) * time.Second)
	return !alternative.Before(value) || alternative.In(location).Format("2006-01-02T15:04:05") != local.Format("2006-01-02T15:04:05")
}
func nextCron(input *pb.AutomationCron, after int64) (int64, error) {
	schedule, location, err := cronSpec(input)
	if err != nil {
		return 0, err
	}
	return nextCronValue(schedule, location, after)
}
func nextCronValue(schedule cron.Schedule, location *time.Location, after int64) (int64, error) {
	at := time.UnixMilli(after)
	for range 8 {
		next := schedule.Next(at)
		if next.IsZero() || !validTime(next.UnixMilli()) {
			return 0, ErrInvalid
		}
		if firstCivilOccurrence(next, location) {
			return next.UnixMilli(), nil
		}
		at = next
	}
	return 0, ErrInvalid
}

// normalizeTarget settles the target kind and refuses a configuration that
// mixes the two. The default stays the command executor, and an agent target
// that carries no node or no frozen definition is rejected here rather than
// stored as a plan that could never name what it writes to.
func normalizeTarget(t *pb.AutomationTarget) error {
	if t.Kind == pb.AutomationTargetKind_AUTOMATION_TARGET_KIND_UNSPECIFIED {
		t.Kind = pb.AutomationTargetKind_AUTOMATION_TARGET_KIND_NON_INTERACTIVE_COMMAND
	}
	switch t.Kind {
	case pb.AutomationTargetKind_AUTOMATION_TARGET_KIND_NON_INTERACTIVE_COMMAND:
		// A command target has no node and no launch definition: the executor
		// creates a new process from a session it already froze, so there is
		// nothing to cold start. Normalizing to SKIP keeps this idempotent —
		// the stored configuration is normalized again to hash it.
		if t.NodeId != "" || t.AgentLaunch != nil || t.ColdStartPolicy == pb.AutomationColdStartPolicy_AUTOMATION_COLD_START_POLICY_LAUNCH_FROZEN {
			return ErrInvalid
		}
		// A command target is pinned to an exact generation of a session this
		// Host froze, so it must name both.
		if !validID(t.SessionId) || t.Generation == 0 {
			return ErrInvalid
		}
		t.ColdStartPolicy = pb.AutomationColdStartPolicy_AUTOMATION_COLD_START_POLICY_SKIP
		return nil
	case pb.AutomationTargetKind_AUTOMATION_TARGET_KIND_AGENT_SESSION_PROMPT:
		if !validID(t.NodeId) || t.AgentLaunch == nil || !validText(t.AgentLaunch.AgentId, 128, false) {
			return ErrInvalid
		}
		// The session and generation are a record of what the plan was defined
		// against, so both may be absent: a plan may legitimately be written
		// for a node whose Agent is not running yet. Identity is the node plus
		// the frozen definition, both re-checked at the write itself.
		if t.SessionId != "" && !validID(t.SessionId) {
			return ErrInvalid
		}
		// Only the default account, and never an argv large enough to be a
		// payload in disguise.
		if t.AgentLaunch.AccountId != "" && t.AgentLaunch.AccountId != "default" {
			return ErrInvalid
		}
		if len(t.AgentLaunch.Args) > 64 || !validText(t.AgentLaunch.WorkingDirectory, 4096, true) || !validText(t.AgentLaunch.PermissionMode, 64, true) || !validText(t.AgentLaunch.ModelId, 128, true) {
			return ErrInvalid
		}
		for _, arg := range t.AgentLaunch.Args {
			if !validText(arg, 4096, true) {
				return ErrInvalid
			}
		}
		t.AgentLaunch.AccountId = "default"
		if t.ColdStartPolicy == pb.AutomationColdStartPolicy_AUTOMATION_COLD_START_POLICY_UNSPECIFIED {
			t.ColdStartPolicy = pb.AutomationColdStartPolicy_AUTOMATION_COLD_START_POLICY_SKIP
		}
		if t.ColdStartPolicy != pb.AutomationColdStartPolicy_AUTOMATION_COLD_START_POLICY_SKIP && t.ColdStartPolicy != pb.AutomationColdStartPolicy_AUTOMATION_COLD_START_POLICY_LAUNCH_FROZEN {
			return ErrInvalid
		}
		return nil
	default:
		return ErrInvalid
	}
}

func normalize(input *pb.AutomationPlanConfig) (*pb.AutomationPlanConfig, error) {
	if input == nil {
		return nil, ErrInvalid
	}
	c := proto.Clone(input).(*pb.AutomationPlanConfig)
	if !validID(c.WorkspaceId) || !validText(c.Title, 256, false) || c.Target == nil || !validID(c.Target.ExecutionHostId) || c.Target.Generation > math.MaxInt64 || !validText(c.PayloadRef, 256, false) || len(c.PayloadSha256) != 32 || c.Schedule == nil || c.MaxRuns > math.MaxInt64 || c.ExpiresAtUnixMs < 0 || c.ExpiresAtUnixMs > maxTimestampMS || c.SafeRetryLimit > 3 {
		return nil, ErrInvalid
	}
	if err := normalizeTarget(c.Target); err != nil {
		return nil, err
	}
	if c.MisfirePolicy == 0 {
		c.MisfirePolicy = Skip
	}
	if c.MisfirePolicy != Skip && c.MisfirePolicy != CoalesceOne {
		return nil, ErrInvalid
	}
	if c.ConcurrencyPolicy == 0 {
		c.ConcurrencyPolicy = Forbid
	}
	if c.ConcurrencyPolicy != Forbid && c.ConcurrencyPolicy != QueueOne {
		return nil, ErrInvalid
	}
	if c.MisfireGraceMs == 0 {
		c.MisfireGraceMs = 60000
	}
	if c.BusyTtlMs == 0 {
		c.BusyTtlMs = 300000
	}
	if c.RetryBackoffMs == 0 {
		c.RetryBackoffMs = 1000
	}
	if c.MisfireGraceMs < 1 || c.MisfireGraceMs > 86400000 || c.BusyTtlMs < 1000 || c.BusyTtlMs > 86400000 || c.RetryBackoffMs < 1000 || c.RetryBackoffMs > 86400000 {
		return nil, ErrInvalid
	}
	switch kind := c.Schedule.Kind.(type) {
	case *pb.AutomationSchedule_Once:
		if kind.Once == nil || !validTime(kind.Once.AtUnixMs) {
			return nil, ErrInvalid
		}
	case *pb.AutomationSchedule_Interval:
		if kind.Interval == nil || !validTime(kind.Interval.AnchorUnixMs) || kind.Interval.IntervalMs < 1000 || kind.Interval.IntervalMs > 31536000000 {
			return nil, ErrInvalid
		}
	case *pb.AutomationSchedule_Cron:
		if _, _, err := cronSpec(kind.Cron); err != nil {
			return nil, err
		}
	case *pb.AutomationSchedule_LoopAfterCompletion:
		if kind.LoopAfterCompletion == nil || kind.LoopAfterCompletion.DelayMs < 1000 || kind.LoopAfterCompletion.DelayMs > 31536000000 || (c.MaxRuns == 0 && c.ExpiresAtUnixMs == 0) {
			return nil, ErrInvalid
		}
	default:
		return nil, ErrInvalid
	}
	return c, nil
}
func firstDue(c *pb.AutomationPlanConfig, now int64) (int64, error) {
	switch kind := c.Schedule.Kind.(type) {
	case *pb.AutomationSchedule_Once:
		return kind.Once.AtUnixMs, nil
	case *pb.AutomationSchedule_Interval:
		anchor, period := kind.Interval.AnchorUnixMs, kind.Interval.IntervalMs
		if now <= anchor {
			return anchor, nil
		}
		n := (now - anchor + period - 1) / period
		next := anchor + n*period
		if !validTime(next) {
			return 0, ErrInvalid
		}
		return next, nil
	case *pb.AutomationSchedule_Cron:
		return nextCron(kind.Cron, now-1)
	case *pb.AutomationSchedule_LoopAfterCompletion:
		return now, nil
	}
	return 0, ErrInvalid
}

// Preview is calculation only and never activates, stores or dispatches a plan.
func Preview(config *pb.AutomationPlanConfig, after time.Time, count int) ([]time.Time, error) {
	c, err := normalize(config)
	if err != nil || count < 1 || count > 20 {
		return nil, ErrInvalid
	}
	now := after.UnixMilli()
	if !validTime(now) {
		return nil, ErrInvalid
	}
	if c.Schedule.GetLoopAfterCompletion() != nil {
		return nil, ErrUnsupported
	}
	first, err := firstDue(c, now)
	if err != nil {
		return nil, err
	}
	values := []time.Time{}
	for len(values) < count && first > 0 {
		if first >= now {
			values = append(values, time.UnixMilli(first).UTC())
		}
		if c.Schedule.GetOnce() != nil {
			break
		}
		if interval := c.Schedule.GetInterval(); interval != nil {
			first += interval.IntervalMs
		} else {
			first, err = nextCron(c.Schedule.GetCron(), first)
			if err != nil {
				return nil, err
			}
		}
		if !validTime(first) {
			break
		}
	}
	return values, nil
}

type dueWindow struct {
	slot               string
	at, next           int64
	count              uint64
	truncated, misfire bool
}

func window(plan *pb.AutomationPlan, now int64) (dueWindow, error) {
	c := plan.Config
	at := plan.NextDueUnixMs
	w := dueWindow{at: at, count: 1}
	if at <= 0 || at > now {
		return w, ErrInvalid
	}
	switch kind := c.Schedule.Kind.(type) {
	case *pb.AutomationSchedule_Once:
		w.slot = fmt.Sprintf("once:%d", at)
	case *pb.AutomationSchedule_Interval:
		w.slot = fmt.Sprintf("interval:%d", (at-kind.Interval.AnchorUnixMs)/kind.Interval.IntervalMs)
		w.count = uint64((now-at)/kind.Interval.IntervalMs) + 1
		w.next = at + int64(w.count)*kind.Interval.IntervalMs
	case *pb.AutomationSchedule_Cron:
		schedule, location, err := cronSpec(kind.Cron)
		if err != nil {
			return w, err
		}
		w.slot = kind.Cron.Timezone + ":" + time.UnixMilli(at).In(location).Format("2006-01-02T15:04")
		next, err := nextCronValue(schedule, location, at)
		if err != nil {
			return w, err
		}
		for next <= now && w.count < maxCronCount {
			w.count++
			next, err = nextCronValue(schedule, location, next)
			if err != nil {
				return w, err
			}
		}
		w.truncated = next <= now
		w.next, err = nextCronValue(schedule, location, now)
		if err != nil {
			return w, err
		}
	case *pb.AutomationSchedule_LoopAfterCompletion:
		w.slot = fmt.Sprintf("loop:%d", plan.RunCount+1)
	default:
		return w, ErrInvalid
	}
	if w.next > maxTimestampMS {
		w.next = 0
	}
	w.misfire = w.count > 1 || now-at > c.MisfireGraceMs
	return w, nil
}
