package bodyread

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
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

// craftedHugePNG builds a syntactically valid PNG signature + IHDR chunk
// declaring the given (width, height) with NO subsequent chunks — just
// enough for image.DecodeConfig to succeed (it reads only the header) while
// staying a handful of bytes on disk, exactly the shape a hostile upload
// would use to claim an enormous decoded size while staying tiny on the
// wire. There is deliberately no IDAT/IEND after this, so a REAL
// image.Decode would fail on it regardless — this test only needs
// DecodeConfig to see the declared dimensions before that ever happens.
func craftedHugePNG(t *testing.T, width, height uint32) []byte {
	t.Helper()
	var buf bytes.Buffer
	// PNG signature.
	buf.Write([]byte{137, 80, 78, 71, 13, 10, 26, 10})

	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], width)
	binary.BigEndian.PutUint32(ihdr[4:8], height)
	ihdr[8] = 8  // bit depth
	ihdr[9] = 6  // color type: truecolor + alpha
	ihdr[10] = 0 // compression
	ihdr[11] = 0 // filter
	ihdr[12] = 0 // interlace

	writeChunk(&buf, "IHDR", ihdr)
	return buf.Bytes()
}

// writeChunk appends one length-prefixed, CRC-checked PNG chunk — the CRC
// covers the chunk type plus its data, per the PNG spec, and MUST be
// correct or image.DecodeConfig rejects the chunk before ever reading the
// dimensions this test needs it to see.
func writeChunk(buf *bytes.Buffer, chunkType string, data []byte) {
	var lenBuf [4]byte
	binary.BigEndian.PutUint32(lenBuf[:], uint32(len(data)))
	buf.Write(lenBuf[:])

	typeAndData := append([]byte(chunkType), data...)
	buf.Write(typeAndData)

	var crcBuf [4]byte
	binary.BigEndian.PutUint32(crcBuf[:], crc32.ChecksumIEEE(typeAndData))
	buf.Write(crcBuf[:])
}

// TestDownscaleForProvider_DeclaredDimensionsAboveCapNeverReachFullDecode
// pins the security guard: a PNG whose HEADER alone claims an enormous
// pixel count must be rejected by the cheap DecodeConfig check and fall
// back to the original bytes, WITHOUT ever calling the real image.Decode
// that would allocate a buffer for the claimed dimensions. Regression for
// kora#314 review finding #3 — an 8 MiB byte-size cap on the wire does not
// bound decoded pixel count, so without this guard a crafted upload could
// OOM the pod on a single request that passes every existing size check.
func TestDownscaleForProvider_DeclaredDimensionsAboveCapNeverReachFullDecode(t *testing.T) {
	// 40000 x 40000 = 1.6 billion px, far past maxDecodePixels (50M) — and
	// the crafted file itself is only a few dozen bytes, proving the guard
	// fires on the DECLARED size, not the file's actual byte size.
	huge := craftedHugePNG(t, 40000, 40000)
	require.Less(t, len(huge), 100, "the crafted header must stay tiny — the attack is a small file claiming huge dimensions")

	out, mime, err := downscaleForProvider(huge, "image/png")

	require.NoError(t, err, "an over-cap header must degrade gracefully, not error")
	assert.True(t, bytes.Equal(huge, out), "must fall back to the ORIGINAL bytes unchanged")
	assert.Equal(t, "image/png", mime, "mime must also stay unchanged on this fallback path")
}

// TestDeclaredPixelsExceedCap tests the cap comparison DIRECTLY, isolated
// from downscaleForProvider's decode-failure fallback — a crafted header
// with no real pixel data would fail a full image.Decode regardless of
// whether the pixel-count guard is even present, which would silently mask
// a broken or deleted guard behind the same observable "unchanged output,
// no error" outcome in the end-to-end test above. This test can only pass
// if declaredPixelsExceedCap itself does the right comparison.
func TestDeclaredPixelsExceedCap(t *testing.T) {
	require.True(t, declaredPixelsExceedCap(craftedHugePNG(t, 40000, 40000)),
		"40000x40000 (1.6B px) must exceed maxDecodePixels (50M)")
	require.False(t, declaredPixelsExceedCap(craftedHugePNG(t, 1000, 1000)),
		"1000x1000 (1M px) must NOT exceed maxDecodePixels (50M)")
	require.False(t, declaredPixelsExceedCap([]byte("not a png at all")),
		"an undecodable header must not be reported as over-cap — that is downscaleForProvider's decode-failure path to own")
}

// TestDownscaleForProvider_DeclaredDimensionsAtCapStillDecodes proves the
// guard is bounded correctly on the OTHER side too: a real image whose
// pixel count is comfortably under maxDecodePixels must still downscale
// normally, not be rejected by an overly aggressive cap.
func TestDownscaleForProvider_DeclaredDimensionsAtCapStillDecodes(t *testing.T) {
	src := synthImage(2000, 1000) // 2,000,000 px — far under maxDecodePixels
	data := encodeJPEG(t, src)

	out, mime, err := downscaleForProvider(data, "image/jpeg")

	require.NoError(t, err)
	assert.Equal(t, "image/jpeg", mime)
	decoded, _, err := image.Decode(bytes.NewReader(out))
	require.NoError(t, err)
	assert.LessOrEqual(t, decoded.Bounds().Dx(), maxDimension)
}

// kora#365. The distinguishing property: a box filter returns the MEAN of the
// source block, point sampling returns one MEMBER of it. On a 2x1 checker of
// pure black and pure white halved horizontally, the mean is mid-grey and no
// member is — so this cannot pass under a nearest-neighbour implementation.
func TestBoxAverageResizeAveragesRatherThanSamples(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 4, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 4; x++ {
			shade := uint8(0)
			if x%2 == 1 {
				shade = 255
			}
			src.Set(x, y, color.RGBA{R: shade, G: shade, B: shade, A: 255})
		}
	}

	dst := boxAverageResize(src, 2, 1)
	require.Equal(t, 2, dst.Bounds().Dx())
	require.Equal(t, 1, dst.Bounds().Dy())

	// Each destination pixel covers one black and one white column over both
	// rows: (0+255)/2 = 127 after integer division.
	for dx := 0; dx < 2; dx++ {
		r, g, b, _ := dst.At(dx, 0).RGBA()
		require.EqualValues(t, 127, r>>8, "column %d red is not the block mean", dx)
		require.EqualValues(t, 127, g>>8, "column %d green is not the block mean", dx)
		require.EqualValues(t, 127, b>>8, "column %d blue is not the block mean", dx)
	}
}

// Every source pixel must land in exactly one destination box. A filter that
// computed boxes from destination CENTRES rather than edges would skip source
// pixels at the seams, which is the defect being fixed.
func TestBoxAverageResizeCoversEverySourcePixel(t *testing.T) {
	// A 3x3 of distinct values averaged to 1x1 must be the mean of all nine.
	src := image.NewRGBA(image.Rect(0, 0, 3, 3))
	total := 0
	for y := 0; y < 3; y++ {
		for x := 0; x < 3; x++ {
			v := uint8((y*3 + x) * 10)
			total += int(v)
			src.Set(x, y, color.RGBA{R: v, G: v, B: v, A: 255})
		}
	}
	dst := boxAverageResize(src, 1, 1)
	r, _, _, _ := dst.At(0, 0).RGBA()
	require.EqualValues(t, total/9, r>>8, "the single output pixel must be the mean of all nine inputs")
}

// A non-integer ratio must not index outside the source.
func TestBoxAverageResizeHandlesNonIntegerRatios(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 7, 5))
	for y := 0; y < 5; y++ {
		for x := 0; x < 7; x++ {
			src.Set(x, y, color.RGBA{R: 10, G: 20, B: 30, A: 255})
		}
	}
	require.NotPanics(t, func() {
		dst := boxAverageResize(src, 3, 2)
		r, g, b, _ := dst.At(2, 1).RGBA()
		require.EqualValues(t, 10, r>>8)
		require.EqualValues(t, 20, g>>8)
		require.EqualValues(t, 30, b>>8)
	})
}
