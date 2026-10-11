package resolve

import (
	"bytes"
	"context"
	"errors"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/capturemedia"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"image"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

type archiveObjects struct {
	puts int
	fail bool
}

func (s *archiveObjects) Put(context.Context, string, []byte) error {
	s.puts++
	if s.fail {
		return errors.New("storage down")
	}
	return nil
}
func (s *archiveObjects) Delete(context.Context, string) error { return nil }
func TestPhotoArchiveHTTPBoundary(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Fatal("TEST_DATABASE_URL required")
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	var valid bytes.Buffer
	require.NoError(t, jpeg.Encode(&valid, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil))
	for _, tc := range []struct {
		name   string
		image  []byte
		fail   bool
		status int
		calls  int
	}{
		{"stored", valid.Bytes(), false, 200, 1},
		{"invalid", []byte("not an image"), false, 400, 0},
		{"storage unavailable", valid.Bytes(), true, 503, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			owner := uuid.New()
			require.NoError(t, db.Exec("INSERT INTO users(id,firebase_uid,email) VALUES (?,?,?)", owner, "archive-http-"+owner.String(), owner.String()+"@test.invalid").Error)
			t.Cleanup(func() {
				require.NoError(t, db.Exec("DELETE FROM users WHERE id = ?", owner).Error)
				require.NoError(t, db.Exec("DELETE FROM photo_object_deletions WHERE object_key LIKE ?", "captures/"+owner.String()+"/%").Error)
			})
			objects := &archiveObjects{fail: tc.fail}
			tp := &stubTP{photo: ai.Resolution{Tier: ai.TierFollowUp}}
			h := NewHandler(tp, nil).WithPhotoArchive(capturemedia.New(db, objects))
			gin.SetMode(gin.TestMode)
			r := gin.New()
			r.Use(func(c *gin.Context) { c.Set("user_id", owner) })
			r.POST("/resolve/photo", h.ResolvePhoto)
			body, contentType := buildMultipart(t, "file", "meal.jpg", "image/jpeg", tc.image)
			request := httptest.NewRequest(http.MethodPost, "/resolve/photo", body)
			request.Header.Set("Content-Type", contentType)
			response := httptest.NewRecorder()
			r.ServeHTTP(response, request)
			require.Equal(t, tc.status, response.Code, response.Body.String())
			require.Equal(t, tc.calls, objects.puts)
			if tc.status == 200 {
				require.Equal(t, "image/jpeg", tp.gotMime)
				var completed int64
				require.NoError(t, db.Table("photo_captures").Where("user_id = ? AND analysis_status = 'completed'", owner).Count(&completed).Error)
				require.EqualValues(t, 1, completed)
			} else {
				require.Zero(t, tp.gotSize)
			}
		})
	}
}
