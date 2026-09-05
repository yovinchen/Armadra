package updates

import (
	"errors"
	"strconv"
	"strings"

	pb "armadra.local/host/gen/armadra/v1"
)

// ErrVersion means a tag could not be read as a release identity. A release
// whose tag cannot be parsed is skipped, never guessed at: string ordering is
// not a version order, and "v10" must not lose to "v9".
var ErrVersion = errors.New("release tag is not a semantic version")

const maxVersionText = 128

// ParseVersion reads "1.2.3", "v1.2.3" or "1.2.3-beta.1" structurally. Build
// metadata after "+" is accepted and dropped: it never takes part in ordering.
func ParseVersion(value string) (*pb.SemanticVersion, error) {
	text := strings.TrimSpace(value)
	if text == "" || len(text) > maxVersionText {
		return nil, ErrVersion
	}
	text = strings.TrimPrefix(text, "v")
	if build := strings.IndexByte(text, '+'); build >= 0 {
		if !identifiers(text[build+1:]) {
			return nil, ErrVersion
		}
		text = text[:build]
	}
	prerelease := ""
	if dash := strings.IndexByte(text, '-'); dash >= 0 {
		prerelease = text[dash+1:]
		text = text[:dash]
		if prerelease == "" || !identifiers(prerelease) {
			return nil, ErrVersion
		}
	}
	parts := strings.Split(text, ".")
	if len(parts) != 3 {
		return nil, ErrVersion
	}
	numbers := make([]uint32, 3)
	for index, part := range parts {
		if part == "" || len(part) > 9 || (len(part) > 1 && part[0] == '0') {
			return nil, ErrVersion
		}
		number, err := strconv.ParseUint(part, 10, 32)
		if err != nil {
			return nil, ErrVersion
		}
		numbers[index] = uint32(number)
	}
	return &pb.SemanticVersion{Major: numbers[0], Minor: numbers[1], Patch: numbers[2], Prerelease: prerelease}, nil
}

// FormatVersion is for diagnostics and tests only; nothing on the wire depends
// on it. The structured message stays the source of truth.
func FormatVersion(version *pb.SemanticVersion) string {
	if version == nil {
		return ""
	}
	text := strconv.FormatUint(uint64(version.GetMajor()), 10) + "." +
		strconv.FormatUint(uint64(version.GetMinor()), 10) + "." +
		strconv.FormatUint(uint64(version.GetPatch()), 10)
	if version.GetPrerelease() != "" {
		text += "-" + version.GetPrerelease()
	}
	return text
}

// Compare orders two release identities by SemVer precedence: -1, 0 or +1.
// A nil version sorts below every parsed one.
func Compare(left, right *pb.SemanticVersion) int {
	if left == nil || right == nil {
		switch {
		case left == nil && right == nil:
			return 0
		case left == nil:
			return -1
		default:
			return 1
		}
	}
	for _, pair := range [][2]uint32{
		{left.GetMajor(), right.GetMajor()},
		{left.GetMinor(), right.GetMinor()},
		{left.GetPatch(), right.GetPatch()},
	} {
		if pair[0] != pair[1] {
			if pair[0] < pair[1] {
				return -1
			}
			return 1
		}
	}
	return comparePrerelease(left.GetPrerelease(), right.GetPrerelease())
}

// A final release outranks every pre-release of the same numbers: "1.2.0" is
// newer than "1.2.0-beta.2", so a stable build is never pushed backwards.
func comparePrerelease(left, right string) int {
	switch {
	case left == right:
		return 0
	case left == "":
		return 1
	case right == "":
		return -1
	}
	leftParts, rightParts := strings.Split(left, "."), strings.Split(right, ".")
	for index := 0; index < len(leftParts) && index < len(rightParts); index++ {
		if result := compareIdentifier(leftParts[index], rightParts[index]); result != 0 {
			return result
		}
	}
	switch {
	case len(leftParts) < len(rightParts):
		return -1
	case len(leftParts) > len(rightParts):
		return 1
	default:
		return 0
	}
}

func compareIdentifier(left, right string) int {
	leftNumber, leftNumeric := numeric(left)
	rightNumber, rightNumeric := numeric(right)
	switch {
	case leftNumeric && rightNumeric:
		switch {
		case leftNumber < rightNumber:
			return -1
		case leftNumber > rightNumber:
			return 1
		default:
			return 0
		}
	case leftNumeric:
		return -1
	case rightNumeric:
		return 1
	default:
		return strings.Compare(left, right)
	}
}

func numeric(value string) (uint64, bool) {
	if value == "" || len(value) > 18 {
		return 0, false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return 0, false
		}
	}
	number, err := strconv.ParseUint(value, 10, 64)
	return number, err == nil
}

// identifiers accepts the SemVer alphabet for a pre-release or build segment.
func identifiers(value string) bool {
	if value == "" || len(value) > maxVersionText {
		return false
	}
	for _, r := range value {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r == '-', r == '.':
		default:
			return false
		}
	}
	return !strings.Contains(value, "..") && !strings.HasPrefix(value, ".") && !strings.HasSuffix(value, ".")
}
