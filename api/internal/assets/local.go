package assets

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Local writes objects to the filesystem. It exists so the avatar path can be
// exercised end to end -- in tests and on a laptop -- without GCS credentials,
// and so a missing bucket is a configuration difference rather than a code path
// that only ever runs in production.
type Local struct {
	dir           string
	publicBaseURL string
}

func NewLocal(dir, publicBaseURL string) Store {
	return Local{dir: dir, publicBaseURL: publicBaseURL}
}

func (l Local) Put(_ context.Context, path string, data []byte, _ string) error {
	full, err := l.resolve(path)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return fmt.Errorf("assets: create dir: %w", err)
	}
	if err := os.WriteFile(full, data, 0o644); err != nil {
		return fmt.Errorf("assets: write object: %w", err)
	}
	return nil
}

func (l Local) Delete(_ context.Context, path string) error {
	full, err := l.resolve(path)
	if err != nil {
		return err
	}
	// Already gone is the outcome the caller asked for.
	if err := os.Remove(full); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("assets: delete object: %w", err)
	}
	return nil
}

func (l Local) URL(path string) string { return joinPublic(l.publicBaseURL, path) }

// resolve refuses any path that would escape the store's directory. Today's
// only caller composes paths from a UUID, so nothing can traverse -- but a
// store that joins text into a filesystem path and trusts its callers is one
// careless caller away from writing anywhere the process can.
func (l Local) resolve(path string) (string, error) {
	clean := filepath.Clean(filepath.FromSlash(path))
	if filepath.IsAbs(clean) || strings.HasPrefix(clean, "..") {
		return "", fmt.Errorf("assets: refusing path outside the store: %q", path)
	}
	full := filepath.Join(l.dir, clean)
	rel, err := filepath.Rel(l.dir, full)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("assets: refusing path outside the store: %q", path)
	}
	return full, nil
}
