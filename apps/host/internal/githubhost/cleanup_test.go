package githubhost

import (
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
)

func TestRerunOnlyRestartsRunsTheRemoteOffersToRestart(t *testing.T) {
	mock := newMock(t)
	mock.rollup = "failure"
	service, _ := newService(t, mock)
	ref := repository(t, service)

	// The producer is not GitHub Actions, so there is no restart endpoint. The
	// answer says so instead of pretending a click did something.
	result, err := service.RerunChecks(testContext, caller(ScopeRead, ScopeWrite), &pb.RerunGithubChecksRequest{
		Repository: ref, Number: 9, ExpectedHeadSha: headSHA,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ReasonCode != "NOT_RERUNNABLE" || len(result.Outcomes) != 0 {
		t.Fatalf("expected NOT_RERUNNABLE with nothing sent, got %+v", result)
	}
	if len(mock.reruns) != 0 {
		t.Fatalf("a non-rerunnable check reached the remote: %v", mock.reruns)
	}
}

func TestRerunSendsTheWorkflowRunAndReReadsTheSameHead(t *testing.T) {
	mock := newMock(t)
	mock.rollup = "failure"
	mock.actions = true
	service, _ := newService(t, mock)
	ref := repository(t, service)

	result, err := service.RerunChecks(testContext, caller(ScopeRead, ScopeWrite), &pb.RerunGithubChecksRequest{
		Repository: ref, Number: 9, ExpectedHeadSha: headSHA, FailedOnly: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Outcomes) != 1 || result.Outcomes[0].State != pb.GithubWriteState_GITHUB_WRITE_STATE_APPLIED {
		t.Fatalf("expected one applied restart, got %+v", result.Outcomes)
	}
	if result.Outcomes[0].RequestedValue != "77" || result.Outcomes[0].Target != "workflow_run" {
		t.Fatalf("the outcome must name the workflow run it restarted: %+v", result.Outcomes[0])
	}
	if len(mock.reruns) != 1 || mock.reruns[0] != "/repos/owner/repo/actions/runs/77/rerun-failed-jobs" {
		t.Fatalf("unexpected rerun requests: %v", mock.reruns)
	}
	// The summary that comes back describes the head the rerun was aimed at.
	if result.Checks.GetHeadSha() != headSHA {
		t.Fatalf("checks describe another commit: %q", result.Checks.GetHeadSha())
	}
}

func TestRerunRefusesWhenTheHeadMoved(t *testing.T) {
	mock := newMock(t)
	mock.rollup = "failure"
	mock.actions = true
	service, _ := newService(t, mock)
	ref := repository(t, service)

	result, err := service.RerunChecks(testContext, caller(ScopeRead, ScopeWrite), &pb.RerunGithubChecksRequest{
		Repository: ref, Number: 9, ExpectedHeadSha: "0000000000000000000000000000000000000000",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ReasonCode != "HEAD_MOVED" {
		t.Fatalf("expected HEAD_MOVED, got %q", result.ReasonCode)
	}
	if len(mock.reruns) != 0 {
		t.Fatalf("a rerun for a moved head reached the remote: %v", mock.reruns)
	}
}

func TestDeleteBranchRefusesWhenTheRefMovedAndDeletesWhenItDidNot(t *testing.T) {
	mock := newMock(t)
	mock.refSHA = "1111111111111111111111111111111111111111"
	service, _ := newService(t, mock)
	ref := repository(t, service)
	write := caller(ScopeRead, ScopeWrite)

	moved, err := service.DeleteBranch(testContext, write, &pb.DeleteGithubBranchRequest{
		Repository: ref, Branch: "feature/x", ExpectedSha: headSHA,
	})
	if err != nil {
		t.Fatal(err)
	}
	if moved.Deleted || moved.ReasonCode != "REF_MOVED" {
		t.Fatalf("expected REF_MOVED, got %+v", moved)
	}
	if len(mock.deletedRef) != 0 {
		t.Fatalf("a branch that moved was deleted anyway: %v", mock.deletedRef)
	}

	mock.refSHA = headSHA
	deleted, err := service.DeleteBranch(testContext, write, &pb.DeleteGithubBranchRequest{
		Repository: ref, Branch: "feature/x", ExpectedSha: headSHA,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !deleted.Deleted {
		t.Fatalf("expected the branch to be deleted, got %+v", deleted)
	}
	if len(mock.deletedRef) != 1 || mock.deletedRef[0] != "feature%2Fx" {
		t.Fatalf("unexpected delete requests: %v", mock.deletedRef)
	}

	// Deleting it again is not this call's doing, and is reported as such.
	again, err := service.DeleteBranch(testContext, write, &pb.DeleteGithubBranchRequest{
		Repository: ref, Branch: "feature/x", ExpectedSha: headSHA,
	})
	if err != nil {
		t.Fatal(err)
	}
	if again.Deleted || again.ReasonCode != "NOT_FOUND" {
		t.Fatalf("expected NOT_FOUND for a branch that is already gone, got %+v", again)
	}
}

func TestDeleteBranchRequiresTheShaTheReaderSaw(t *testing.T) {
	mock := newMock(t)
	service, _ := newService(t, mock)
	ref := repository(t, service)
	if _, err := service.DeleteBranch(testContext, caller(ScopeRead, ScopeWrite), &pb.DeleteGithubBranchRequest{
		Repository: ref, Branch: "feature/x",
	}); err != ErrInvalid {
		t.Fatalf("expected ErrInvalid without an expected sha, got %v", err)
	}
	// Read scope alone never writes.
	if _, err := service.DeleteBranch(testContext, caller(ScopeRead), &pb.DeleteGithubBranchRequest{
		Repository: ref, Branch: "feature/x", ExpectedSha: headSHA,
	}); err == nil {
		t.Fatal("read scope must not be able to delete a branch")
	}
	if _, err := service.RerunChecks(testContext, caller(ScopeRead), &pb.RerunGithubChecksRequest{
		Repository: ref, Number: 9,
	}); err == nil {
		t.Fatal("read scope must not be able to restart checks")
	}
}
