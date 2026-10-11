package assets

import (
	"context"
	"errors"
	"fmt"

	"cloud.google.com/go/storage"
)

// GCS stores objects in a Cloud Storage bucket. Authentication is Application
// Default Credentials -- the same mechanism firebase.NewApp already relies on
// in internal/auth/verifier.go, so a pod that can verify a token can also write
// an object, with no second credential to manage.
type GCS struct {
	client        *storage.Client
	bucket        string
	publicBaseURL string
}

func NewGCS(ctx context.Context, bucket, publicBaseURL string) (Store, error) {
	client, err := storage.NewClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("assets: gcs client: %w", err)
	}
	return GCS{client: client, bucket: bucket, publicBaseURL: publicBaseURL}, nil
}

func (g GCS) Put(ctx context.Context, path string, data []byte, contentType string) error {
	w := g.client.Bucket(g.bucket).Object(path).NewWriter(ctx)
	w.ContentType = contentType
	// A superseded object is reaped by a lifecycle rule, never overwritten:
	// AvatarPath issues a fresh version per write, so a Put never targets an
	// existing object and CacheControl can be immutable.
	w.CacheControl = "public, max-age=31536000, immutable"
	if _, err := w.Write(data); err != nil {
		_ = w.Close()
		return fmt.Errorf("assets: write object: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("assets: close object: %w", err)
	}
	return nil
}

func (g GCS) Delete(ctx context.Context, path string) error {
	err := g.client.Bucket(g.bucket).Object(path).Delete(ctx)
	if err != nil && !errors.Is(err, storage.ErrObjectNotExist) {
		return fmt.Errorf("assets: delete object: %w", err)
	}
	return nil
}

func (g GCS) URL(path string) string { return joinPublic(g.publicBaseURL, path) }
