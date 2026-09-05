// Package automation is a persistent scheduling kernel, independent of open
// clients. It dispatches only through an explicit executor interface; it never
// creates a PTY, runs a shell or treats delivered input as successful work.
package automation

import (
	"context"
	"errors"
	"sync"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

var (
	ErrInvalid       = errors.New("invalid automation configuration")
	ErrAuthorization = errors.New("automation authorization is invalid")
	ErrUnsupported   = errors.New("automation target capability is unavailable")
	ErrReceipt       = errors.New("automation receipt does not match its operation")
)

const (
	Draft       = pb.AutomationPlanState_AUTOMATION_PLAN_STATE_DRAFT
	Active      = pb.AutomationPlanState_AUTOMATION_PLAN_STATE_ACTIVE
	Paused      = pb.AutomationPlanState_AUTOMATION_PLAN_STATE_PAUSED
	Expired     = pb.AutomationPlanState_AUTOMATION_PLAN_STATE_EXPIRED
	Due         = pb.AutomationRunState_AUTOMATION_RUN_STATE_DUE
	Claimed     = pb.AutomationRunState_AUTOMATION_RUN_STATE_CLAIMED
	Waiting     = pb.AutomationRunState_AUTOMATION_RUN_STATE_WAITING_TARGET
	Dispatching = pb.AutomationRunState_AUTOMATION_RUN_STATE_DISPATCHING
	Delivered   = pb.AutomationRunState_AUTOMATION_RUN_STATE_DELIVERED
	Running     = pb.AutomationRunState_AUTOMATION_RUN_STATE_RUNNING
	Succeeded   = pb.AutomationRunState_AUTOMATION_RUN_STATE_SUCCEEDED
	Failed      = pb.AutomationRunState_AUTOMATION_RUN_STATE_FAILED
	Cancelled   = pb.AutomationRunState_AUTOMATION_RUN_STATE_CANCELLED
	Skipped     = pb.AutomationRunState_AUTOMATION_RUN_STATE_SKIPPED
	RunExpired  = pb.AutomationRunState_AUTOMATION_RUN_STATE_EXPIRED
	Unknown     = pb.AutomationRunState_AUTOMATION_RUN_STATE_UNKNOWN
	Skip        = pb.AutomationMisfirePolicy_AUTOMATION_MISFIRE_POLICY_SKIP
	CoalesceOne = pb.AutomationMisfirePolicy_AUTOMATION_MISFIRE_POLICY_COALESCE_ONE
	Forbid      = pb.AutomationConcurrencyPolicy_AUTOMATION_CONCURRENCY_POLICY_FORBID
	QueueOne    = pb.AutomationConcurrencyPolicy_AUTOMATION_CONCURRENCY_POLICY_QUEUE_ONE
)

type TargetState uint8

const (
	TargetUnknown TargetState = iota
	TargetReady
	TargetBusy
	TargetOffline
	TargetUnsupported
)

type TargetStatus struct {
	State      TargetState
	Generation uint64
}

// Authorization contains stable references supplied by the authenticated caller.
// Never pass a browser access/refresh token as either field.
type Authorization struct{ PrincipalID, AuthorizationID string }
type Authorizer interface {
	Verify(context.Context, Authorization, *pb.AutomationPlanConfig) error
}

// Implementations must respect context deadlines. Lookup UNKNOWN includes a
// missing/unavailable journal; NOT_DISPATCHED requires affirmative, durable
// evidence of no effects. Dispatch and Lookup return correlated receipts.
type Dispatcher interface {
	Supports(context.Context, *pb.AutomationTarget) (TargetStatus, error)
	Dispatch(context.Context, *pb.AutomationRun) (*pb.AutomationReceipt, error)
	Lookup(context.Context, string) (*pb.AutomationReceipt, error)
}
type Options struct {
	Clock func() time.Time
	// MonotonicClock is independently injectable for clock-step tests. Its
	// elapsed durations govern in-process Interval waits, never persisted IDs.
	MonotonicClock  func() time.Time
	InstanceID      string
	ClaimLease      time.Duration
	DispatchTimeout time.Duration
	PollInterval    time.Duration
}
type Engine struct {
	store                        *storage.Store
	dispatcher                   Dispatcher
	authorizer                   Authorizer
	clock                        func() time.Time
	monotonic                    func() time.Time
	intervalMu                   sync.Mutex
	intervalClocks               map[string]intervalClock
	instance                     string
	lease, dispatchTimeout, poll time.Duration
	tickGate                     chan struct{}
}
type PlanSnapshot struct {
	Plan     *pb.AutomationPlan
	Revision uint64
}
type RunSnapshot struct {
	Run      *pb.AutomationRun
	Revision uint64
}
type RunsPage struct {
	Runs    []RunSnapshot
	NextID  string
	HasMore bool
}

func terminal(state pb.AutomationRunState) bool {
	return state == Succeeded || state == Failed || state == Cancelled || state == Skipped || state == RunExpired
}
func preDispatch(state pb.AutomationRunState) bool {
	return state == Due || state == Claimed || state == Waiting
}
