package capturemedia

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/ai"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type testObjects struct {
	data                map[string][]byte
	failPut, failDelete bool
}

func (s *testObjects) Put(_ context.Context, key string, body []byte) error {
	if s.failPut {
		return errors.New("storage unavailable")
	}
	s.data[key] = append([]byte(nil), body...)
	return nil
}
func (s *testObjects) Delete(_ context.Context, key string) error {
	if s.failDelete {
		return errors.New("storage unavailable")
	}
	delete(s.data, key)
	return nil
}
func testPhoto(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 8, 6))
	img.Set(0, 0, color.White)
	var b bytes.Buffer
	require.NoError(t, jpeg.Encode(&b, img, nil))
	return b.Bytes()
}
func archiveDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Fatal("TEST_DATABASE_URL required for archive integration tests")
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	return db
}
func archiveUser(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec("INSERT INTO users (id,firebase_uid,email) VALUES (?,?,?)", id, "archive-"+id.String(), id.String()+"@test.invalid").Error)
	t.Cleanup(func() {
		require.NoError(t, db.Exec("DELETE FROM users WHERE id = ?", id).Error)
		require.NoError(t, db.Exec("DELETE FROM photo_object_deletions WHERE object_key LIKE ?", "captures/"+id.String()+"/%").Error)
	})
	return id
}
func TestArchivePersistsNormalizedPhotoAndAnalysis(t *testing.T) {
	db := archiveDB(t)
	owner := archiveUser(t, db)
	id := uuid.New()
	objects := &testObjects{data: map[string][]byte{}}
	svc := New(db, objects)
	original := testPhoto(t)
	exif := []byte("Exif\x00\x00GPS-private-location")
	original = append(append(append([]byte{}, original[:2]...), 0xff, 0xe1, 0, byte(len(exif)+2)), append(exif, original[2:]...)...)
	normalized, err := svc.Start(context.Background(), owner, id, original)
	require.NoError(t, err)
	require.NotEmpty(t, normalized)
	require.NotContains(t, string(normalized), "GPS-private-location")
	require.Len(t, objects.data, 1)
	var row struct {
		ContentType   string
		Width, Height int
		StorageStatus string
	}
	require.NoError(t, db.Table("photo_captures").Where("id = ? AND user_id = ?", id, owner).Take(&row).Error)
	require.Equal(t, "image/jpeg", row.ContentType)
	require.Equal(t, 8, row.Width)
	require.Equal(t, 6, row.Height)
	require.Equal(t, "stored", row.StorageStatus)
	require.NoError(t, svc.Finish(context.Background(), owner, id, ai.Resolution{Tier: ai.TierFollowUp}, nil))
	var status string
	require.NoError(t, db.Raw("SELECT analysis_status FROM photo_captures WHERE id = ?", id).Scan(&status).Error)
	require.Equal(t, "completed", status)
	other := archiveUser(t, db)
	require.ErrorIs(t, svc.Finish(context.Background(), other, id, ai.Resolution{}, nil), ErrNotFound)
}
func TestArchiveRejectsInvalidImageBeforePersistence(t *testing.T) {
	db := archiveDB(t)
	owner := archiveUser(t, db)
	objects := &testObjects{data: map[string][]byte{}}
	svc := New(db, objects)
	_, err := svc.Start(context.Background(), owner, uuid.New(), []byte("not an image"))
	require.ErrorIs(t, err, ErrInvalidImage)
	require.Empty(t, objects.data)
	var count int64
	db.Table("photo_captures").Where("user_id = ?", owner).Count(&count)
	require.Zero(t, count)
}
func TestAccountDeletionQueuesAndRetriesPrivatePhotoRemoval(t *testing.T) {
	db := archiveDB(t)
	owner := archiveUser(t, db)
	id := uuid.New()
	objects := &testObjects{data: map[string][]byte{}}
	svc := New(db, objects)
	_, err := svc.Start(context.Background(), owner, id, testPhoto(t))
	require.NoError(t, err)
	require.NoError(t, db.Exec("DELETE FROM users WHERE id = ?", owner).Error)
	var count int64
	db.Table("photo_captures").Where("id = ?", id).Count(&count)
	require.Zero(t, count)
	require.NoError(t, svc.Cleanup(context.Background(), time.Now()))
	require.Len(t, objects.data, 1)
	objects.failDelete = true
	require.Error(t, svc.Cleanup(context.Background(), time.Now().Add(11*time.Minute)))
	require.Len(t, objects.data, 1)
	objects.failDelete = false
	require.NoError(t, svc.Cleanup(context.Background(), time.Now().Add(11*time.Minute)))
	require.Empty(t, objects.data)
	require.NoError(t, svc.Cleanup(context.Background(), time.Now().Add(11*time.Minute)))
}
func TestStorageFailureRetainsFailureMetadata(t *testing.T) {
	db := archiveDB(t)
	owner := archiveUser(t, db)
	id := uuid.New()
	objects := &testObjects{data: map[string][]byte{}, failPut: true}
	svc := New(db, objects)
	_, err := svc.Start(context.Background(), owner, id, testPhoto(t))
	require.Error(t, err)
	var status string
	require.NoError(t, db.Raw("SELECT storage_status FROM photo_captures WHERE id = ?", id).Scan(&status).Error)
	require.Equal(t, "failed", status)
}
