// downscale.go shrinks an oversized body-composition screenshot before it is
// sent to a vision provider. The pixel cap and the resampler both live in
// internal/imageproc, shared with avatar normalisation -- see kora#365 for why
// this file averages rather than point-samples, and kora#449 for why a second
// caller made them shared.
package bodyread

import (
	"bytes"
	"image"
	"image/jpeg"  // also registers jpeg for image.Decode
	_ "image/png" // format registration for image.Decode; scale-app screenshots are jpeg or png (confirmed against apps/mobile's image-picker mime types)

	"github.com/tesserix/kora/api/internal/imageproc"
)

// maxDimension bounds the long side of an image sent to the provider. 1024
// is deliberately generous for this use case: the source is large,
// high-contrast UI text on a clean background, not a photograph where fine
// detail would be lost at this resolution — #314's cost comment says
// shrinking screenshots this aggressively belongs in the first slice, since
// vision-model cost scales with image size and a scale-app screenshot needs
// nowhere near full resolution to stay legible.
const maxDimension = 1024

// downscaleJPEGQuality is the re-encode quality used regardless of the
// input format. 85 is a standard "visually lossless for UI/text" quality
// that keeps output size well below the original while leaving numerals and
// labels sharp enough to read.
const downscaleJPEGQuality = 85

// downscaleForProvider shrinks data proportionally so its long side is at
// most maxDimension, re-encoding the result as JPEG. It always returns
// "image/jpeg" as the new mime — even when the input was PNG — so callers
// MUST NOT assume the returned mime matches the input mime.
//
// If data cannot be decoded (corrupt bytes, or a format image.Decode does
// not recognize), the ORIGINAL bytes and mime are returned unchanged with no
// error: downscaling is a cost optimization, not a correctness requirement,
// and a decode failure here must never block a call that would otherwise
// succeed against the provider with the original bytes.
//
// An image already at or under maxDimension is returned unchanged too — not
// re-encoded — so a JPEG that never needed resizing is never re-compressed
// as a lossy no-op.
func downscaleForProvider(data []byte, mime string) ([]byte, string, error) {
	// Cheap header-only read BEFORE the real decode allocates anything — see
	// imageproc.MaxDecodePixels' doc comment for why this exists and what it
	// defends against. A config-decode failure is handled identically to a
	// full decode failure below: fall back to the original bytes, no error.
	if imageproc.DeclaredPixelsExceedCap(data) {
		return data, mime, nil
	}

	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return data, mime, nil
	}

	bounds := img.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	longSide := width
	if height > longSide {
		longSide = height
	}
	if longSide <= maxDimension {
		return data, mime, nil
	}

	scale := float64(maxDimension) / float64(longSide)
	newWidth := max(1, int(float64(width)*scale))
	newHeight := max(1, int(float64(height)*scale))

	dst := imageproc.BoxAverageResize(img, newWidth, newHeight)

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: downscaleJPEGQuality}); err != nil {
		// Re-encoding is also an optimization, not a correctness
		// requirement — the same reasoning as the decode-failure branch
		// above: fall back to the original bytes rather than fail the call.
		return data, mime, nil
	}

	return buf.Bytes(), "image/jpeg", nil
}
