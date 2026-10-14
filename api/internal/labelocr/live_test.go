package labelocr

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestLiveNativeMealPhoto(t *testing.T) {
	fixture := os.Getenv("KORA_LIVE_OCR_FIXTURE")
	if fixture == "" {
		t.Skip("KORA_LIVE_OCR_FIXTURE is required for an explicitly enabled live service test")
	}
	photo, err := os.ReadFile(fixture)
	require.NoError(t, err)
	client, err := NewClient(Config{
		UploadURL: os.Getenv("OCR_UPLOAD_URL"), JobURL: os.Getenv("OCR_JOB_URL"),
		KeyID: os.Getenv("OCR_KEY_ID"), Tenant: os.Getenv("OCR_TENANT"), SecretHex: os.Getenv("OCR_KEY_SECRET"),
	}, nil)
	require.NoError(t, err)
	require.NotNil(t, client)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	started := time.Now()
	read, err := client.Read(ctx, photo, "image/jpeg")
	require.NoError(t, err)
	require.Equal(t, "review_required", read.Status)
	require.NotEmpty(t, read.JobID)
	require.Empty(t, read.Fields, "native image processing must not invent label fields")
	require.Zero(t, read.CostUSD)
	t.Logf("live native meal photo: job=%s status=%s duration=%s fields=%d cost=%.2f", read.JobID, read.Status, time.Since(started), len(read.Fields), read.CostUSD)
}
