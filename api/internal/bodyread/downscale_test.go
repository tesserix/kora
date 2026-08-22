package bodyread

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// synthImage builds an in-memory RGBA image of the given size, filled with a
// simple gradient so it is not a single flat color (which some encoders can
// special-case).
func synthImage(width, height int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, color.RGBA{
				R: uint8(x % 256),
				G: uint8(y % 256),
				B: 128,
				A: 255,
			})
		}
	}
	return img
}

func encodeJPEG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}))
	return buf.Bytes()
}

func TestDownscaleForProvider_OversizedImageShrinks(t *testing.T) {
	// Long side (2000) well over maxDimension (1024).
	src := synthImage(2000, 1000)
	data := encodeJPEG(t, src)

	out, mime, err := downscaleForProvider(data, "image/jpeg")
	require.NoError(t, err)
	assert.Equal(t, "image/jpeg", mime)

	decoded, _, err := image.Decode(bytes.NewReader(out))
	require.NoError(t, err, "downscaled output must decode back to a valid JPEG")

	b := decoded.Bounds()
	longSide := b.Dx()
	if b.Dy() > longSide {
		longSide = b.Dy()
	}
	assert.LessOrEqual(t, longSide, maxDimension)
}

func TestDownscaleForProvider_UnderThresholdReturnsUnchanged(t *testing.T) {
	src := synthImage(400, 300) // well under maxDimension
	data := encodeJPEG(t, src)

	out, mime, err := downscaleForProvider(data, "image/jpeg")
	require.NoError(t, err)
	// Byte-identical: never re-encoded/re-compressed when no resize is
	// needed, since that would be a lossy no-op.
	assert.True(t, bytes.Equal(data, out), "unchanged bytes expected for an image already under maxDimension")
	assert.Equal(t, "image/jpeg", mime)
}

func TestDownscaleForProvider_CorruptInputReturnsOriginalNoError(t *testing.T) {
	corrupt := []byte("this is not an image, just some bytes")

	out, mime, err := downscaleForProvider(corrupt, "image/jpeg")
	require.NoError(t, err)
	assert.True(t, bytes.Equal(corrupt, out))
	assert.Equal(t, "image/jpeg", mime)
}

func TestDownscaleForProvider_PNGInputBecomesJPEGMime(t *testing.T) {
	src := synthImage(2000, 1200)
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, src))

	out, mime, err := downscaleForProvider(buf.Bytes(), "image/png")
	require.NoError(t, err)
	assert.Equal(t, "image/jpeg", mime)

	_, format, err := image.Decode(bytes.NewReader(out))
	require.NoError(t, err)
	assert.Equal(t, "jpeg", format)
}
