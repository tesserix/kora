package identity

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/assets"
	"github.com/tesserix/kora/api/internal/user"
)

func pngUpload(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 200, A: 255})
		}
	}
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	return buf.Bytes()
}

func multipartBody(t *testing.T, field, filename string, data []byte) (string, *bytes.Buffer) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile(field, filename)
	require.NoError(t, err)
	_, err = part.Write(data)
	require.NoError(t, err)
	require.NoError(t, mw.Close())
	return mw.FormDataContentType(), &body
}

func avatarEngine(t *testing.T, db *gorm.DB, store assets.Store, as uuid.UUID) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	h := NewHandler(NewServiceWithAssets(NewRepository(db), store))
	r := gin.New()
	r.Use(func(c *gin.Context) { user.SetIDForTest(c, as); c.Next() })
	r.PUT("/v1/me/avatar", h.SetAvatar)
	r.DELETE("/v1/me/avatar", h.ClearAvatar)
	r.GET("/v1/users/lookup", h.Lookup)
	return r
}

func TestAvatar_UploadStoresANormalisedObjectAndReturnsAURL(t *testing.T) {
	db := testDB(t)
	dir := t.TempDir()
	store := assets.NewLocal(dir, "http://localhost:8080/assets")
	id := seedUser(t, db)
	r := avatarEngine(t, db, store, id)

	ct, body := multipartBody(t, "file", "selfie.png", pngUpload(t, 1400, 900))
	req := httptest.NewRequest(http.MethodPut, "/v1/me/avatar", body)
	req.Header.Set("Content-Type", ct)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, 200, rec.Code, rec.Body.String())

	var path string
	require.NoError(t, db.Raw(`SELECT avatar_path FROM users WHERE id = ?`, id).Scan(&path).Error)
	require.NotEmpty(t, path)
	require.Contains(t, rec.Body.String(), store.URL(path))

	// The object on disk is a square JPEG, not the PNG that was uploaded.
	stored, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(path)))
	require.NoError(t, err)
	cfg, format, err := image.DecodeConfig(bytes.NewReader(stored))
	require.NoError(t, err)
	require.Equal(t, "jpeg", format)
	require.Equal(t, cfg.Width, cfg.Height)
}

// Replacing a picture must not leave the old object behind. Every write issues
// a new path, so without an explicit delete the bucket accumulates every
// picture every user ever had — including ones they replaced deliberately.
func TestAvatar_ReplacingDeletesThePreviousObject(t *testing.T) {
	db := testDB(t)
	dir := t.TempDir()
	store := assets.NewLocal(dir, "http://x/assets")
	id := seedUser(t, db)
	svc := NewServiceWithAssets(NewRepository(db), store)

	_, err := svc.SetAvatar(context.Background(), id, pngUpload(t, 600, 600))
	require.NoError(t, err)
	var first string
	require.NoError(t, db.Raw(`SELECT avatar_path FROM users WHERE id = ?`, id).Scan(&first).Error)

	_, err = svc.SetAvatar(context.Background(), id, pngUpload(t, 700, 700))
	require.NoError(t, err)
	var second string
	require.NoError(t, db.Raw(`SELECT avatar_path FROM users WHERE id = ?`, id).Scan(&second).Error)

	require.NotEqual(t, first, second)
	_, statErr := os.Stat(filepath.Join(dir, filepath.FromSlash(first)))
	require.True(t, os.IsNotExist(statErr), "the superseded object must be gone")
}

func TestAvatar_ClearRemovesBothTheRowValueAndTheObject(t *testing.T) {
	db := testDB(t)
	dir := t.TempDir()
	store := assets.NewLocal(dir, "http://x/assets")
	id := seedUser(t, db)
	svc := NewServiceWithAssets(NewRepository(db), store)

	_, err := svc.SetAvatar(context.Background(), id, pngUpload(t, 600, 600))
	require.NoError(t, err)
	var path string
	require.NoError(t, db.Raw(`SELECT avatar_path FROM users WHERE id = ?`, id).Scan(&path).Error)

	require.NoError(t, svc.ClearAvatar(context.Background(), id))

	var after *string
	require.NoError(t, db.Raw(`SELECT avatar_path FROM users WHERE id = ?`, id).Scan(&after).Error)
	require.True(t, after == nil || *after == "")
	_, statErr := os.Stat(filepath.Join(dir, filepath.FromSlash(path)))
	require.True(t, os.IsNotExist(statErr))
}

func TestAvatar_RejectsBytesThatAreNotAnImage(t *testing.T) {
	db := testDB(t)
	r := avatarEngine(t, db, assets.NewLocal(t.TempDir(), "http://x"), seedUser(t, db))
	ct, body := multipartBody(t, "file", "notes.txt", []byte("this is not an image"))
	req := httptest.NewRequest(http.MethodPut, "/v1/me/avatar", body)
	req.Header.Set("Content-Type", ct)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, 400, rec.Code)
}

func TestAvatar_MissingFilePartIs400(t *testing.T) {
	db := testDB(t)
	r := avatarEngine(t, db, assets.NewLocal(t.TempDir(), "http://x"), seedUser(t, db))
	req := httptest.NewRequest(http.MethodPut, "/v1/me/avatar", bytes.NewReader(nil))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=nope")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, 400, rec.Code)
}

// TestAvatar_OversizedUploadIs413 drives the real handler with a request body
// one byte over maxAvatarBodyBytes and asserts the 413 path -- the one
// production branch (the http.MaxBytesError case in SetAvatar, checked
// BEFORE FormFile even returns a part) that had only ever been verified live
// and then had its scratch test deleted. "Verified by inspection, no test" is
// exactly the failure mode this test exists to close off.
//
// The overage is measured, not guessed: multipartBody's envelope (boundary,
// headers, field name, filename) has a fixed byte cost for a given field and
// filename, so this test measures that cost with an empty payload and then
// picks a payload length that lands the total body exactly one byte past the
// cap -- not "some large body", but the precise off-by-one the handler must
// reject.
func TestAvatar_OversizedUploadIs413(t *testing.T) {
	db := testDB(t)
	r := avatarEngine(t, db, assets.NewLocal(t.TempDir(), "http://x"), seedUser(t, db))

	_, empty := multipartBody(t, "file", "big.bin", nil)
	overhead := empty.Len()
	payload := make([]byte, maxAvatarBodyBytes+1-overhead)

	ct, body := multipartBody(t, "file", "big.bin", payload)
	require.Equal(t, maxAvatarBodyBytes+1, body.Len(),
		"the request body must land exactly one byte over the cap for this test to mean anything")

	req := httptest.NewRequest(http.MethodPut, "/v1/me/avatar", body)
	req.Header.Set("Content-Type", ct)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), "image_too_large")
}

// With no bucket configured (assets.Noop), an upload must still SUCCEED and
// simply produce no picture — the first-deploy state described in
// docs/OPEN_QUESTIONS.md. A 500 here would break the profile screen in every
// environment that has no bucket.
func TestAvatar_NoopStoreSucceedsWithNoURL(t *testing.T) {
	db := testDB(t)
	id := seedUser(t, db)
	url, err := NewServiceWithAssets(NewRepository(db), assets.Noop{}).
		SetAvatar(context.Background(), id, pngUpload(t, 600, 600))
	require.NoError(t, err)
	require.Empty(t, url)
}
