// downscale.go shrinks an oversized body-composition screenshot before it is
// sent to a vision provider.
//
// WHY NOT golang.org/x/image/draw: it is not in go.mod/go.sum (verified) and
// this file deliberately does not add it. x/image/draw's bilinear/
// Catmull-Rom interpolators earn their cost on photographs, where smooth
// resampling avoids visible aliasing on natural detail. A smart-scale
// result screenshot is the opposite case: rendered UI text on a flat,
// clean background — exactly the input nearest-neighbor handles adequately,
// since there is no fine photographic detail to alias against. If a future
// caller in this package ever needs high-quality interpolation (a real
// photo, not a screenshot), x/image would need to be added as a new
// dependency then — this file is not a substitute for that decision.
package bodyread

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"  // also registers jpeg for image.Decode
	_ "image/png" // format registration for image.Decode; scale-app screenshots are jpeg or png (confirmed against apps/mobile's image-picker mime types)
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

	dst := nearestNeighborResize(img, newWidth, newHeight)

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: downscaleJPEGQuality}); err != nil {
		// Re-encoding is also an optimization, not a correctness
		// requirement — the same reasoning as the decode-failure branch
		// above: fall back to the original bytes rather than fail the call.
		return data, mime, nil
	}

	return buf.Bytes(), "image/jpeg", nil
}

// nearestNeighborResize maps each destination pixel back to the nearest
// source pixel. No interpolation — see the file's top-of-file doc comment
// for why that is an acceptable tradeoff for rendered UI text on a clean
// background rather than a photograph.
func nearestNeighborResize(src image.Image, newWidth, newHeight int) *image.RGBA {
	srcBounds := src.Bounds()
	srcWidth, srcHeight := srcBounds.Dx(), srcBounds.Dy()

	dst := image.NewRGBA(image.Rect(0, 0, newWidth, newHeight))
	xRatio := float64(srcWidth) / float64(newWidth)
	yRatio := float64(srcHeight) / float64(newHeight)

	for dy := 0; dy < newHeight; dy++ {
		srcY := srcBounds.Min.Y + int(float64(dy)*yRatio)
		for dx := 0; dx < newWidth; dx++ {
			srcX := srcBounds.Min.X + int(float64(dx)*xRatio)
			dst.Set(dx, dy, color.RGBAModel.Convert(src.At(srcX, srcY)))
		}
	}
	return dst
}
