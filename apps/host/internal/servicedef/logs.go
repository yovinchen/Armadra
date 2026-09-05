package servicedef

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	// DefaultLogLines is the tail size when the operator does not ask for one.
	DefaultLogLines = 200
	// MaxLogLines caps --lines. A diagnostic tail is for looking at a recent
	// failure, not for shipping the whole file through a terminal.
	MaxLogLines = 5000
	// maxTailBytes bounds how far back the reader seeks. A log that wrote one
	// enormous line cannot make this command allocate without limit.
	maxTailBytes = 4 << 20
	// tailChunkBytes is the backwards read granularity.
	tailChunkBytes = 64 << 10
)

// Tail returns the last `lines` lines of path, reading only the end of the
// file: it seeks backwards in chunks and stops as soon as it has enough
// newlines, so a multi-gigabyte log costs the same as a small one. The returned
// slice never exceeds `lines` entries and never more than maxTailBytes of text.
func Tail(path string, lines int) ([]string, error) {
	if lines <= 0 {
		lines = DefaultLogLines
	}
	if lines > MaxLogLines {
		lines = MaxLogLines
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: log file must be a regular file", ErrInvalid)
	}
	size := info.Size()
	var collected []byte
	offset := size
	truncated := false
	for offset > 0 {
		if int64(len(collected)) >= maxTailBytes {
			truncated = true
			break
		}
		step := int64(tailChunkBytes)
		if offset < step {
			step = offset
		}
		offset -= step
		chunk := make([]byte, step)
		if _, err := file.ReadAt(chunk, offset); err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		collected = append(chunk, collected...)
		// One extra newline: the first line in the buffer may be a fragment of
		// an earlier line, and it is dropped below unless we reached the start.
		if bytes.Count(collected, []byte{'\n'}) > lines {
			break
		}
	}
	// The first buffered line is a fragment unless the read reached the start of
	// the file or stopped exactly after a newline.
	partial := truncated
	if offset > 0 && !partial {
		var previous [1]byte
		if _, err := file.ReadAt(previous[:], offset-1); err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		partial = previous[0] != '\n'
	}
	text := strings.TrimRight(string(collected), "\n")
	if text == "" {
		return []string{}, nil
	}
	split := strings.Split(text, "\n")
	if partial && len(split) > 1 {
		split = split[1:]
	}
	if len(split) > lines {
		split = split[len(split)-lines:]
	}
	for index, line := range split {
		split[index] = strings.TrimRight(line, "\r")
	}
	return split, nil
}

// LatestStartupLog returns the newest `startup-*.log` the background start
// command wrote into the data directory, or os.ErrNotExist when there is none.
// Names are compared as a tiebreaker so the choice is deterministic when two
// files share a modification time.
func LatestStartupLog(dataDir string) (string, error) {
	matches, err := filepath.Glob(filepath.Join(dataDir, "startup-*.log"))
	if err != nil {
		return "", err
	}
	sort.Strings(matches)
	newest := ""
	var newestTime int64
	for _, candidate := range matches {
		info, err := os.Lstat(candidate)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if stamp := info.ModTime().UnixNano(); newest == "" || stamp > newestTime {
			newest, newestTime = candidate, stamp
		}
	}
	if newest == "" {
		return "", fmt.Errorf("no startup log in %s: %w", dataDir, os.ErrNotExist)
	}
	return newest, nil
}
