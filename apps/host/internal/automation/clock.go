package automation

import (
	"time"

	pb "armadra.local/host/gen/armadra/v1"
)

type intervalClock struct {
	version    uint64
	activation string
	baseMS     int64
	baseMono   time.Time
}

// Interval's in-process timeline never steps backwards. Its persisted anchor
// still defines slot IDs; wall-clock jumps forward form one misfire window.
// This waiting cache is not execution authority: losing it on restart restores
// from the durable UTC cursor and can never resurrect an already recorded slot.
func (e *Engine) intervalNow(plan *pb.AutomationPlan, wall int64) int64 {
	key := plan.Config.WorkspaceId + "/" + plan.Id
	e.intervalMu.Lock()
	defer e.intervalMu.Unlock()
	if plan.State != Active || plan.Config.Schedule.GetInterval() == nil || plan.NextDueUnixMs == 0 {
		delete(e.intervalClocks, key)
		return wall
	}
	mono := e.monotonic()
	mapping, ok := e.intervalClocks[key]
	if !ok || mapping.version != plan.ConfigVersion || mapping.activation != string(plan.ActivationSha256) {
		mapping = intervalClock{version: plan.ConfigVersion, activation: string(plan.ActivationSha256), baseMS: wall, baseMono: mono}
	}
	elapsed := mono.Sub(mapping.baseMono).Milliseconds()
	if elapsed < 0 {
		elapsed = 0
	}
	projected := min(maxTimestampMS, mapping.baseMS+elapsed)
	if wall > projected {
		mapping.baseMS = wall
		mapping.baseMono = mono
		projected = wall
	}
	e.intervalClocks[key] = mapping
	return max(wall, projected)
}
func (e *Engine) resetIntervalClock(plan *pb.AutomationPlan, wall int64) {
	if plan.Config.Schedule.GetInterval() == nil {
		return
	}
	e.intervalMu.Lock()
	defer e.intervalMu.Unlock()
	e.intervalClocks[plan.Config.WorkspaceId+"/"+plan.Id] = intervalClock{version: plan.ConfigVersion, activation: string(plan.ActivationSha256), baseMS: wall, baseMono: e.monotonic()}
}
