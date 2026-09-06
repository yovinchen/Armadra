package sessionhost

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"
)

// The periodic half of reconciliation (Go Host 业务所有权迁移 §2.6, §6.2 session 行).
//
// `Reclaim` is correct and was called exactly twice: once when a switch
// settles, and once, best effort, at boot. Everything between those two moments
// was left to a client pressing something. A pane that died while nobody was
// looking stayed RUNNING in this Host's records until the next `Start`, and a
// machine that came back after a restart left its sessions LOST until somebody
// noticed. Neither is a state a person can act on, because neither is visible.
//
// So the same reconciliation runs on a timer. It is the same function, with the
// same one-directional rule — the execution host's listing is the truth, this
// Host's records are a projection — and it is idempotent, so a tick that finds
// nothing writes nothing and publishes no event.
//
// This is deliberately *not* how a run's end is normally learned. The Worker
// reports an exit upward the moment it sees one (upcall 140), and that path is
// seconds where this one is minutes. The timer is the backstop for the cases an
// upcall cannot cover: a Worker that was not running when the pane died, a
// frame dropped while the Host itself was down, a machine that has come back
// since. A backstop that runs often enough to be useful and rarely enough to
// cost nothing is the whole design.

// DefaultReconcileInterval is the backstop's period. It is minutes rather than
// seconds because the upcall is what makes an exit visible promptly; this only
// has to be faster than a person noticing something is stale.
const DefaultReconcileInterval = 2 * time.Minute

// MinReconcileInterval floors what an operator (or a test) can ask for. A
// reconcile opens a Worker channel, so a one-millisecond period would be a
// process-spawn loop rather than a health check.
const MinReconcileInterval = 100 * time.Millisecond

// Reconcile runs the periodic reclaim until the context ends.
//
// The first pass runs immediately: the interesting moment is right after this
// Host started, when its records describe processes it did not start, and
// waiting a full period to look would leave that window uncovered.
//
// A failing pass is reported and the loop continues. A machine that is
// unreachable this minute is the state `Reclaim` already records as LOST, and
// stopping the loop over it would mean the one thing that could resolve it
// never runs again.
func (s *Service) Reconcile(ctx context.Context, interval time.Duration) error {
	if s == nil {
		return ErrInvalid
	}
	if interval <= 0 {
		interval = DefaultReconcileInterval
	}
	if interval < MinReconcileInterval {
		interval = MinReconcileInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		s.reconcileOnce(ctx)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// reconcileOnce is one pass, with its result reported the way the boot pass
// reports it. Silence means nothing drifted.
func (s *Service) reconcileOnce(ctx context.Context) {
	outcome, err := s.Reclaim(ctx, "")
	switch {
	case err != nil:
		s.note("sessions could not be reconciled", err)
	case len(outcome.Ended)+len(outcome.Lost)+len(outcome.Regenerated) > 0:
		fmt.Printf("Armadra reconciled sessions: %d ended, %d unreachable, %d replaced\n",
			len(outcome.Ended), len(outcome.Lost), len(outcome.Regenerated))
	}
}

func (s *Service) note(what string, err error) {
	if err == nil || errors.Is(err, ErrNoWorker) {
		// A Host with no reachable execution host is a state, not a fault, and
		// saying so every two minutes would be noise that hides a real one.
		return
	}
	fmt.Fprintln(os.Stderr, "Armadra:", what+":", err)
}
