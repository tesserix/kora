// Package imageproc holds the image primitives shared by every caller that
// accepts a user-supplied picture. It exists because there is now more than
// one: body-composition screenshots (internal/bodyread) and profile pictures
// (internal/identity). Two copies of a security guard is one copy that gets
// fixed.
package imageproc

import (
	"bytes"
	"image"
)

// MaxDecodePixels bounds the pixel count image.Decode is allowed to allocate,
// checked via the cheap image.DecodeConfig header read BEFORE the real decode
// ever runs. This is a SECURITY guard, not an optimization: an 8 MiB byte cap
// bounds the ENCODED size on the wire, but a crafted PNG can declare enormous
// pixel dimensions in a few header bytes while staying well under that cap --
// image.Decode allocates the FULL pixel buffer for whatever dimensions the
// header claims, so without this check an authenticated user could OOM the pod
// with one upload that passes every existing size check. 50,000,000 px
// (~7071x7071) is far larger than any real photo or screenshot while staying a
// small, bounded allocation.
const MaxDecodePixels = 50_000_000

// DeclaredPixelsExceedCap reports whether data's HEADER ALONE (read via the
// cheap image.DecodeConfig, which never allocates a pixel buffer) declares more
// pixels than MaxDecodePixels allows. It is its own function so it can be
// exercised directly against a crafted header -- proving the CAP COMPARISON
// fires, independent of what a caller's decode-failure path would otherwise do
// with the same bytes, which is how a missing guard hides.
//
// A header that fails to decode at all is NOT treated as exceeding the cap;
// that is the caller's decode-failure path to handle.
func DeclaredPixelsExceedCap(data []byte) bool {
	cfg, _, cfgErr := image.DecodeConfig(bytes.NewReader(data))
	if cfgErr != nil {
		return false
	}
	return int64(cfg.Width)*int64(cfg.Height) > MaxDecodePixels
}
