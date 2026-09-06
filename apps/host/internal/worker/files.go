package worker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

type ReadOptions struct {
	RootID, Path   string
	Offset         uint64
	MaxBytes       uint32
	ExpectedSHA256 []byte
}

func absolutePath(value string) bool {
	return len(value) > 0 && len(value) <= 32768 && utf8.ValidString(value) && !strings.ContainsRune(value, 0) && filepath.IsAbs(value)
}
func relativePath(value string, allowRoot bool) bool {
	if allowRoot && value == "." {
		return true
	}
	if value == "" || len(value) > 32768 || !utf8.ValidString(value) || strings.ContainsAny(value, "\x00\\") || strings.HasPrefix(value, "/") || filepath.VolumeName(value) != "" {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}
func (c *Client) RegisterRoot(ctx context.Context, rootID, absolute string) (*pb.RegisteredRoot, error) {
	if !rootIDPattern.MatchString(rootID) || !absolutePath(absolute) {
		return nil, &Error{Code: CodeInvalid}
	}
	response, err := c.exchange(ctx, &pb.WorkerRequest{Action: &pb.WorkerRequest_RegisterRoot{RegisterRoot: &pb.RegisterRootRequest{RootId: rootID, Path: absolute}}}, "root")
	if err != nil {
		return nil, err
	}
	return proto.Clone(response.GetRegisteredRoot()).(*pb.RegisteredRoot), nil
}

// Returned paths are canonical relative paths, which may differ from a request
// alias if the Worker resolved a symlink inside the registered root.
func (c *Client) ListDirectory(ctx context.Context, rootID, relative string) (*pb.WorkerDirectory, error) {
	if relative == "" {
		relative = "."
	}
	if !rootIDPattern.MatchString(rootID) || !relativePath(relative, true) {
		return nil, &Error{Code: CodeInvalid}
	}
	response, err := c.exchange(ctx, &pb.WorkerRequest{Action: &pb.WorkerRequest_ListDirectory{ListDirectory: &pb.WorkerListDirectoryRequest{RootId: rootID, Path: relative}}}, "directory")
	if err != nil {
		return nil, err
	}
	return proto.Clone(response.GetDirectory()).(*pb.WorkerDirectory), nil
}

// Chunk bytes deliberately remain bytes: UTF-8 codepoints can span chunks.
// The caller supplies the first chunk's SHA-256 on every subsequent request and
// should verify that digest after reassembly before using a complete document.
func (c *Client) ReadFileChunk(ctx context.Context, options ReadOptions) (*pb.WorkerFileChunk, error) {
	maximum := options.MaxBytes
	if maximum == 0 {
		maximum = c.hello.MaxFileChunkBytes
	}
	if !rootIDPattern.MatchString(options.RootID) || !relativePath(options.Path, false) || maximum == 0 || maximum > c.hello.MaxFileChunkBytes || options.Offset > uint64(c.hello.MaxTextFileBytes) || (options.ExpectedSHA256 != nil && len(options.ExpectedSHA256) != sha256.Size) || (options.Offset > 0 && len(options.ExpectedSHA256) != sha256.Size) {
		return nil, &Error{Code: CodeInvalid}
	}
	expected := append([]byte(nil), options.ExpectedSHA256...)
	response, err := c.exchange(ctx, &pb.WorkerRequest{Action: &pb.WorkerRequest_ReadFile{ReadFile: &pb.WorkerReadFileRequest{RootId: options.RootID, Path: options.Path, Offset: options.Offset, MaxBytes: maximum, ExpectedSha256: expected}}}, "chunk")
	if err != nil {
		return nil, err
	}
	return proto.Clone(response.GetFileChunk()).(*pb.WorkerFileChunk), nil
}

func (c *Client) validResult(request *pb.WorkerRequest, response *pb.WorkerResponse) bool {
	if input := request.GetCommand(); input != nil {
		return c.validCommand(input, response.GetCommand())
	}
	if input := request.GetAgent(); input != nil {
		return c.validAgent(input, response.GetAgent())
	}
	if request.GetHello() != nil {
		return validHello(response.GetHello(), request.HostId, response.InstanceId)
	}
	if input := request.GetRegisterRoot(); input != nil {
		root := response.GetRegisteredRoot()
		return root != nil && root.RootId == input.RootId && absolutePath(root.CanonicalPath)
	}
	if input := request.GetListDirectory(); input != nil {
		directory := response.GetDirectory()
		if directory == nil || directory.RootId != input.RootId || !relativePath(directory.Path, true) {
			return false
		}
		names := map[string]bool{}
		for _, entry := range directory.Entries {
			if entry == nil || entry.Name == "" || !utf8.ValidString(entry.Name) || strings.ContainsAny(entry.Name, "\x00/\\") || entry.Name == "." || entry.Name == ".." || names[entry.Name] || !relativePath(entry.Path, false) || entry.Path != path.Join(directory.Path, entry.Name) || (entry.Kind != "file" && entry.Kind != "directory") {
				return false
			}
			names[entry.Name] = true
		}
		return true
	}
	// The ownership reply is compared against the request in ownership.go,
	// which is where the epoch rules live. Here it only has to be a well-formed
	// record for a domain this version knows.
	if input := request.GetSetWriteOwnership(); input != nil {
		record := response.GetWriteOwnership()
		return record != nil && record.Domain == input.Domain && record.Epoch > 0 &&
			(record.Owner == pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME || record.Owner == pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST)
	}
	if input := request.GetGetWriteOwnership(); input != nil {
		record := response.GetWriteOwnership()
		return record != nil && record.Domain == input.Domain && record.Epoch > 0 &&
			(record.Owner == pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_RUNTIME || record.Owner == pb.CanvasOwnershipOwner_CANVAS_OWNERSHIP_OWNER_HOST)
	}
	// The reverse import report is compared against the package the Host wrote
	// in canvashost/reverse.go, which is where the digests live. Here it only
	// has to answer the request it was sent, with one entry per workspace and
	// a canonical digest in each: a report that named a different package or
	// carried none would be accepted by any comparison that never ran.
	if input := request.GetApplyReverseExport(); input != nil {
		report := response.GetReverseImport()
		if report == nil || report.Domain != input.Domain || report.ImportId != input.ImportId ||
			!bytes.Equal(report.IndexSha256, input.IndexSha256) || report.Epoch == 0 {
			return false
		}
		seen := map[string]bool{}
		for _, file := range report.Reexported {
			if file == nil || file.WorkspaceId == "" || len(file.ContentSha256) != sha256.Size || seen[file.WorkspaceId] {
				return false
			}
			seen[file.WorkspaceId] = true
		}
		return true
	}
	// The settings snapshot is compared against the request in settings.go,
	// which is where the direction rules live, and against the export package
	// in settingshost, which is where the digests are decided. Here it only has
	// to be a self-consistent snapshot: a document whose digest describes other
	// bytes would pass every later comparison that trusted the digest.
	if request.GetSettings() != nil {
		return validSettingsSnapshot(response.GetSettings())
	}
	// The filesystem read is a query about the Runtime's own rows, and the
	// comparison that matters happens in fshost. Here the frame only has to be
	// a well-formed answer to the action that was sent: a root per workspace,
	// named once, with the permission set actually present — an absent one
	// would be read as "nothing is allowed" by a caller that then compared it
	// against a package saying otherwise.
	if input := request.GetFilesystem(); input != nil {
		roots := response.GetFilesystem().GetRoots()
		if input.GetListRoots() == nil || roots == nil {
			return false
		}
		seen := map[string]bool{}
		for _, root := range roots.GetRoots() {
			if root == nil || root.GetWorkspaceId() == "" || seen[root.GetWorkspaceId()] ||
				root.GetPermissions() == nil || root.GetCanonicalPath() == "" {
				return false
			}
			seen[root.GetWorkspaceId()] = true
		}
		return true
	}
	// The git frames are compared against what the Host asked for in githost,
	// which is where the queue's own rules live. Here the reply only has to be
	// an answer to the action that was sent, and shaped so a later comparison
	// is worth making: an outcome naming a different operation would be
	// recorded against the one this Host queued.
	if input := request.GetGit(); input != nil {
		return validGitResult(input, response.GetGit())
	}
	// The session frames are screened in sessions.go, where the run rules live.
	// Here a frame only has to be a well-formed answer of the shape that was
	// asked for: a listing whose entries name no session cannot be compared
	// with anything, and letting one through would make a handback pass on a
	// row nobody can name.
	if input := request.GetSession(); input != nil {
		result := response.GetSession()
		if result == nil {
			return false
		}
		if states := result.GetSessions(); states != nil {
			seen := map[string]bool{}
			for _, state := range states.GetSessions() {
				if state == nil || state.GetSessionId() == "" || seen[state.GetSessionId()] {
					return false
				}
				seen[state.GetSessionId()] = true
			}
			return input.GetListSessions() != nil || input.GetReclaimRuns() != nil
		}
		if run := result.GetRun(); run != nil {
			return run.GetSessionId() != "" && (input.GetStartRun() != nil || input.GetSignalRun() != nil)
		}
		if capture := result.GetCapture(); capture != nil {
			return input.GetCaptureRun() != nil && capture.GetSessionId() != ""
		}
		if result.GetTitle() != nil {
			return input.GetSuggestTitle() != nil
		}
		if usage := result.GetContextUsage(); usage != nil {
			return input.GetContextUsage() != nil &&
				(len(usage.GetUsage()) == 0 || len(usage.GetUsageSha256()) == sha256.Size)
		}
		return false
	}
	// The agent frames are screened in agents_host.go, where the cursor and the
	// delivery rules live. Here a frame only has to be a well-formed answer of
	// the shape that was asked for: a listing whose entries name no node cannot
	// be compared with anything, and letting one through would make a handback
	// pass on a record nobody can name.
	if input := request.GetAgentHost(); input != nil {
		return validAgentResult(input, response.GetAgentHost())
	}
	if input := request.GetReadFile(); input != nil {
		chunk := response.GetFileChunk()
		if chunk == nil || chunk.RootId != input.RootId || !relativePath(chunk.Path, false) || chunk.MimeType == "" || len(chunk.MimeType) > 256 || len(chunk.Sha256) != sha256.Size || chunk.Offset != input.Offset || chunk.TotalBytes > uint64(c.hello.MaxTextFileBytes) || chunk.Offset > chunk.TotalBytes || len(chunk.Data) > int(input.MaxBytes) || uint64(len(chunk.Data)) > chunk.TotalBytes-chunk.Offset || chunk.Eof != (chunk.Offset+uint64(len(chunk.Data)) == chunk.TotalBytes) || (!chunk.Eof && len(chunk.Data) == 0) || (len(input.ExpectedSha256) > 0 && !bytes.Equal(input.ExpectedSha256, chunk.Sha256)) {
			return false
		}
		if chunk.Offset == 0 && chunk.Eof {
			sum := sha256.Sum256(chunk.Data)
			if !bytes.Equal(sum[:], chunk.Sha256) {
				return false
			}
		}
		return true
	}
	return false
}
