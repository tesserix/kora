package capturemedia

import (
	"cloud.google.com/go/storage"
	"context"
	"errors"
)

type GCS struct {
	client *storage.Client
	bucket string
}

func NewGCS(ctx context.Context, bucket string) (*GCS, error) {
	client, err := storage.NewClient(ctx)
	if err != nil {
		return nil, err
	}
	return &GCS{client: client, bucket: bucket}, nil
}
func (g *GCS) Put(ctx context.Context, key string, body []byte) error {
	w := g.client.Bucket(g.bucket).Object(key).If(storage.Conditions{DoesNotExist: true}).NewWriter(ctx)
	w.ContentType = "image/jpeg"
	w.CacheControl = "private, no-store"
	w.ContentDisposition = "attachment"
	if _, err := w.Write(body); err != nil {
		_ = w.Close()
		return err
	}
	return w.Close()
}
func (g *GCS) Delete(ctx context.Context, key string) error {
	err := g.client.Bucket(g.bucket).Object(key).Delete(ctx)
	if errors.Is(err, storage.ErrObjectNotExist) {
		return nil
	}
	return err
}
