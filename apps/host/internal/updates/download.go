package updates

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
)

// Downloading a release artifact.
//
// The Host does this only for `upgrade`, never on behalf of a network caller:
// letting a remote request make the Host fetch and install its own replacement
// is remote code installation, which is why DownloadUpdate stays UNSUPPORTED.
//
// Every bound is checked while the bytes arrive rather than afterwards. A
// digest computed over a file that was already written is a digest computed
// over whatever fitted on the disk.

// MaxArtifactBytes is the largest artifact this Host will fetch. The desktop
// bundle is the biggest thing a release publishes and is far below it.
const MaxArtifactBytes = 512 << 20

// ErrDownload marks a refusal that leaves nothing installed. Its text never
// contains the URL: an operator's source can carry a token.
var ErrDownload = errors.New("download refused")

// Artifact is what a completed download produced.
type Artifact struct {
	// Path is the downloaded file, inside the directory the caller named.
	Path string
	// Sha256 is what the bytes actually hashed to.
	Sha256 []byte
	Bytes  uint64
	// SignaturePath is the detached signature, when the release published one.
	SignaturePath string
}

// AssetName is the published file name an artifact URL ends in. It is read
// from the URL rather than trusted from elsewhere, because it is what the
// signature's trusted comment is checked against.
func AssetName(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	name := filepath.Base(parsed.Path)
	if name == "." || name == "/" || strings.ContainsAny(name, `/\`) {
		return ""
	}
	unescaped, err := url.PathUnescape(name)
	if err != nil {
		return name
	}
	return unescaped
}

// Fetch downloads one artifact and its detached signature into directory.
//
// The declared size is a precondition, not a hint: a body that does not match
// the length the release index published is not the artifact that was checked,
// whatever its bytes hash to. The digest is computed as the bytes arrive and
// compared in constant time, and a mismatch removes the file before returning.
func Fetch(ctx context.Context, client *http.Client, artifact *pb.UpdateArtifact, directory string) (Artifact, error) {
	var result Artifact
	if artifact == nil || artifact.GetUrl() == "" {
		return result, fmt.Errorf("%w: no artifact to download", ErrDownload)
	}
	name := AssetName(artifact.GetUrl())
	if name == "" {
		return result, fmt.Errorf("%w: the artifact URL names no file", ErrDownload)
	}
	if artifact.GetSizeBytes() == 0 || artifact.GetSizeBytes() > MaxArtifactBytes {
		return result, fmt.Errorf("%w: the release declares an implausible size for %s", ErrDownload, name)
	}
	if len(artifact.GetSha256()) != sha256.Size {
		// A release that publishes no digest for an artifact has not said what
		// the bytes should be, so nothing downstream could check them.
		return result, fmt.Errorf("%w: %s: the release publishes no digest for %s", ErrDownload, ReasonDigestMismatch, name)
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return result, err
	}
	path := filepath.Join(directory, name)
	sum, written, err := fetchTo(ctx, client, artifact.GetUrl(), path, artifact.GetSizeBytes())
	if err != nil {
		os.Remove(path)
		return result, err
	}
	if subtle.ConstantTimeCompare(sum, artifact.GetSha256()) != 1 {
		os.Remove(path)
		return result, fmt.Errorf("%w: %s: %s hashed to %s", ErrDownload, ReasonDigestMismatch, name, hex.EncodeToString(sum))
	}
	result = Artifact{Path: path, Sha256: sum, Bytes: written}
	// The signature is fetched only when the release said one exists. Its
	// absence is reported by the caller as unsigned, never as verified.
	if artifact.GetSignature().GetState() == pb.UpdateSignatureState_UPDATE_SIGNATURE_STATE_PRESENT {
		signaturePath := path + ".sig"
		if _, _, err := fetchTo(ctx, client, artifact.GetUrl()+".sig", signaturePath, 0); err != nil {
			os.Remove(path)
			os.Remove(signaturePath)
			return Artifact{}, err
		}
		result.SignaturePath = signaturePath
	}
	return result, nil
}

// maxSignatureBytes bounds a detached signature. A minisign signature is four
// short lines; anything larger is not one.
const maxSignatureBytes = 8 << 10

// fetchTo streams one URL into path under a size budget, hashing as it goes.
// declared is the exact length required, or 0 for a signature whose length the
// release index does not publish.
func fetchTo(ctx context.Context, client *http.Client, rawURL, path string, declared uint64) (sum []byte, written uint64, err error) {
	budget := int64(MaxArtifactBytes)
	if declared == 0 {
		budget = maxSignatureBytes
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("%w: the artifact address is unusable", ErrDownload)
	}
	request.Header.Set("Accept", "application/octet-stream")
	response, err := client.Do(request)
	if err != nil {
		return nil, 0, fmt.Errorf("%w: %s", ErrDownload, ReasonUnreachable)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, 0, fmt.Errorf("%w: %s", ErrDownload, ReasonUnreachable)
	}
	if declared > 0 && response.ContentLength >= 0 && uint64(response.ContentLength) != declared {
		return nil, 0, fmt.Errorf("%w: the download is not the length the release declared", ErrDownload)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, 0, err
	}
	defer func() {
		if closeErr := file.Close(); err == nil {
			err = closeErr
		}
	}()
	hash := sha256.New()
	// One byte past the budget is read on purpose: a body that fills the cap
	// exactly cannot otherwise be told from one that was cut off there.
	copied, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, budget+1))
	if err != nil {
		// A connection dropped mid-body leaves a shorter file, which is not a
		// smaller artifact: it is no artifact at all.
		return nil, 0, fmt.Errorf("%w: the download ended before the artifact did", ErrDownload)
	}
	if copied > budget {
		return nil, 0, fmt.Errorf("%w: the download exceeds its budget", ErrDownload)
	}
	if declared > 0 && uint64(copied) != declared {
		return nil, 0, fmt.Errorf("%w: the download is not the length the release declared", ErrDownload)
	}
	if err = file.Sync(); err != nil {
		return nil, 0, err
	}
	return hash.Sum(nil), uint64(copied), nil
}
