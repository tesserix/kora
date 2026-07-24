//go:build smoke

package providers

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestGeminiTranscribeSmoke needs GEMINI_API_KEY and a KORA_SMOKE_AUDIO path
// (a short spoken-food clip, e.g. audio/mp4). Run:
//
//	set -a && . ./.env && set +a
//	KORA_SMOKE_AUDIO=/path/clip.m4a go test -tags smoke ./internal/ai/providers/ -run TestGeminiTranscribeSmoke -v
func TestGeminiTranscribeSmoke(t *testing.T) {
	key := os.Getenv("GEMINI_API_KEY")
	path := os.Getenv("KORA_SMOKE_AUDIO")
	if key == "" || path == "" {
		t.Skip("GEMINI_API_KEY/KORA_SMOKE_AUDIO not set — skipping transcribe smoke")
	}
	audio, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read audio: %v", err)
	}
	p, err := NewGeminiProvider(context.Background(), key)
	if err != nil {
		t.Fatalf("gemini: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	text, usage, err := p.Transcribe(ctx, audio, "audio/mp4")
	if err != nil {
		t.Fatalf("Transcribe: %v", err)
	}
	if text == "" {
		t.Fatal("empty transcript")
	}
	t.Logf("transcript=%q usage=%+v", text, usage)
}
