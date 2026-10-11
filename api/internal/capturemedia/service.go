// Package capturemedia retains private meal photos and their analysis lineage.
package capturemedia

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	_ "image/png"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel/trace"
	_ "golang.org/x/image/webp"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/ai"
)

var ErrInvalidImage = errors.New("capture: invalid or oversized image")
var ErrNotFound = errors.New("capture: not found")
var imageSlots = make(chan struct{}, 2)

// Objects is the private external object store; keys are generated server-side.
type Objects interface {
	Put(context.Context, string, []byte) error
	Delete(context.Context, string) error
}

type Service struct {
	db      *gorm.DB
	objects Objects
}

func New(db *gorm.DB, objects Objects) *Service { return &Service{db: db, objects: objects} }

func normalize(input []byte) ([]byte, int, int, error) {
	if len(input) == 0 || len(input) > 8<<20 {
		return nil, 0, 0, ErrInvalidImage
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(input))
	if err != nil || (format != "jpeg" && format != "png" && format != "webp") || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > 16_000_000 {
		return nil, 0, 0, ErrInvalidImage
	}
	decoded, _, err := image.Decode(bytes.NewReader(input))
	if err != nil {
		return nil, 0, 0, ErrInvalidImage
	}
	opaque := image.NewRGBA(decoded.Bounds())
	draw.Draw(opaque, opaque.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(opaque, opaque.Bounds(), decoded, decoded.Bounds().Min, draw.Over)
	var out bytes.Buffer
	if err := jpeg.Encode(&out, opaque, &jpeg.Options{Quality: 85}); err != nil {
		return nil, 0, 0, ErrInvalidImage
	}
	if out.Len() > 8<<20 {
		return nil, 0, 0, ErrInvalidImage
	}
	return out.Bytes(), cfg.Width, cfg.Height, nil
}

// Start commits a manifest before uploading, so account deletion always knows the object key.
func (s *Service) Start(ctx context.Context, owner, id uuid.UUID, input []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	select {
	case imageSlots <- struct{}{}:
		defer func() { <-imageSlots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	body, width, height, err := normalize(input)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(body)
	key := "captures/" + owner.String() + "/" + id.String() + ".jpg"
	err = s.db.WithContext(ctx).Exec(`INSERT INTO photo_captures (id,user_id,object_key,sha256,content_type,byte_size,width,height,storage_status,trace_id) VALUES (?,?,?,?,?,?,?,?,?,?)`, id, owner, key, hex.EncodeToString(sum[:]), "image/jpeg", len(body), width, height, "pending", trace.SpanContextFromContext(ctx).TraceID().String()).Error
	if err != nil {
		return nil, fmt.Errorf("capture: create manifest: %w", err)
	}
	err = s.objects.Put(ctx, key, body)
	status := "stored"
	if err != nil {
		status = "failed"
	}
	finishCtx, finishCancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer finishCancel()
	result := s.db.WithContext(finishCtx).Exec("UPDATE photo_captures SET storage_status = ?, updated_at = now() WHERE id = ? AND user_id = ?", status, id, owner)
	if err != nil {
		return nil, fmt.Errorf("capture: upload: %w", err)
	}
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected != 1 {
		return nil, ErrNotFound
	}
	return body, nil
}

func (s *Service) Finish(ctx context.Context, owner, id uuid.UUID, res ai.Resolution, analysisErr error) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	status := "completed"
	var body any
	if analysisErr != nil {
		status = "failed"
		if errors.Is(analysisErr, context.Canceled) {
			status = "canceled"
		}
	} else {
		encoded, err := json.Marshal(res)
		if err != nil {
			return err
		}
		body = string(encoded)
	}
	result := s.db.WithContext(ctx).Exec("UPDATE photo_captures SET analysis_status = ?, analysis = ?::jsonb, updated_at = now() WHERE id = ? AND user_id = ?", status, body, id, owner)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrNotFound
	}
	return nil
}

// Cleanup is safe to run on every replica: deleting an immutable key twice is harmless.
func (s *Service) Cleanup(ctx context.Context, now time.Time) error {
	if err := s.db.WithContext(ctx).Exec("UPDATE photo_captures SET analysis_status = 'failed', updated_at = now() WHERE analysis_status = 'pending' AND created_at < ?", now.Add(-10*time.Minute)).Error; err != nil {
		return err
	}
	var keys []string
	if err := s.db.WithContext(ctx).Table("photo_object_deletions").Where("not_before <= ?", now).Order("not_before").Limit(100).Pluck("object_key", &keys).Error; err != nil {
		return err
	}
	var failures []error
	for _, key := range keys {
		operation, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := s.objects.Delete(operation, key)
		cancel()
		if err != nil {
			failures = append(failures, errors.New("capture: object deletion failed"))
			continue
		}
		if err := s.db.WithContext(ctx).Exec("DELETE FROM photo_object_deletions WHERE object_key = ?", key).Error; err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func (s *Service) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		tick, cancel := context.WithTimeout(ctx, 45*time.Second)
		if err := s.Cleanup(tick, time.Now()); err != nil && ctx.Err() == nil {
			slog.ErrorContext(ctx, "capture photo deletion retry needed")
		}
		cancel()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
