package canvashost

import (
	"context"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/storage"
)

// The canvas domain's half of a write-ownership switch
// (Go Host 业务所有权迁移 §2.11, steps 3 and 4).
//
// The state machine lives in internal/ownership and knows nothing about
// canvases. What it needs from each domain is three things: how the data is
// taken over, how it is handed back, and where the Host's event stream stands.
// This file is the canvas answering those three questions; everything it calls
// already existed for the CLI switch.
//
// The reports are the same comparisons as before, restated in the generic
// message so a caller can read one report shape whichever domain moved.

// Projector is the canvas service seen as one domain of the switch.
type Projector struct{ service *Service }

// AsProjector exposes the canvas service to the ownership state machine.
func (s *Service) AsProjector() Projector { return Projector{service: s} }

// Adopt projects a staged import into canvas entities and verifies it item for
// item. A report that did not match is returned, not swallowed: the operator
// needs to see which check failed.
func (p Projector) Adopt(ctx context.Context, importID string) (*pb.OwnershipReport, error) {
	if _, err := p.service.Materialize(ctx, importID); err != nil {
		return nil, err
	}
	report, err := p.service.Verify(ctx, importID)
	if err != nil {
		return nil, err
	}
	return ownershipReport(report), nil
}

// Release writes the reverse export the Host owes the Runtime and verifies what
// actually reached the disk.
func (p Projector) Release(ctx context.Context, directory string) (*pb.OwnershipReport, error) {
	report, err := p.service.Export(ctx, directory)
	return ownershipReport(report), err
}

// Watermark is the Host's canvas event sequence right now.
func (p Projector) Watermark(ctx context.Context) (uint64, error) {
	_, watermark, err := p.service.store.Watermark(ctx)
	return watermark, err
}

// ownershipReport restates a canvas consistency report in the generic shape.
// The check names, counts and differing identifiers are carried across
// unchanged: a report that lost its differences on the way out would say only
// that something failed.
func ownershipReport(report *pb.CanvasConsistencyReport) *pb.OwnershipReport {
	if report == nil {
		return nil
	}
	result := &pb.OwnershipReport{
		Domain:           pb.WriteOwnershipDomain_WRITE_OWNERSHIP_DOMAIN_CANVAS,
		ImportId:         report.ImportId,
		ExportId:         report.ExportId,
		ManifestSha256:   report.ManifestSha256,
		EntityCount:      report.EntityCount,
		Matched:          report.Matched,
		VerifiedAtUnixMs: report.VerifiedAtUnixMs,
	}
	for _, check := range report.Checks {
		result.Checks = append(result.Checks, &pb.ConsistencyCheck{
			Check:         check.Check,
			ExpectedCount: check.ExpectedCount,
			ActualCount:   check.ActualCount,
			Matched:       check.Matched,
			Differences:   check.Differences,
		})
	}
	return result
}

// Domain is the name the canvas is registered under.
const Domain = storage.OwnershipDomainCanvas
