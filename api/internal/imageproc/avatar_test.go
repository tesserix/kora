package imageproc

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"

	"github.com/stretchr/testify/require"
)

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 128, A: 255})
		}
	}
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	return buf.Bytes()
}

// A PNG input must come out as a JPEG. Re-encoding is not a format preference:
// it is HOW EXIF is removed, including the GPS coordinates a selfie carries.
// Stripping named metadata fields would leave whatever fields we did not think
// to name.
func TestNormalizeAvatar_AlwaysProducesJPEG(t *testing.T) {
	out, err := NormalizeAvatar(pngBytes(t, 900, 900))
	require.NoError(t, err)
	_, format, err := image.DecodeConfig(bytes.NewReader(out))
	require.NoError(t, err)
	require.Equal(t, "jpeg", format)
}

func TestNormalizeAvatar_ResizesDownTo512(t *testing.T) {
	out, err := NormalizeAvatar(pngBytes(t, 2000, 1200))
	require.NoError(t, err)
	cfg, _, err := image.DecodeConfig(bytes.NewReader(out))
	require.NoError(t, err)
	require.Equal(t, AvatarDimension, cfg.Width)
	require.Equal(t, AvatarDimension, cfg.Height, "an avatar is square")
}

// Upscaling a small picture would invent detail and make a 60x60 thumbnail look
// worse, not better, while quadrupling the bytes stored.
func TestNormalizeAvatar_DoesNotUpscale(t *testing.T) {
	out, err := NormalizeAvatar(pngBytes(t, 120, 120))
	require.NoError(t, err)
	cfg, _, err := image.DecodeConfig(bytes.NewReader(out))
	require.NoError(t, err)
	require.Equal(t, 120, cfg.Width)
	require.Equal(t, 120, cfg.Height)
}

// A crafted header declares enormous dimensions in a few bytes while staying
// under any byte cap. image.Decode allocates the FULL pixel buffer for whatever
// the header claims, so this must be refused BEFORE the decode, not after.
func TestNormalizeAvatar_RejectsADecodeBombHeader(t *testing.T) {
	// A valid PNG header declaring 60000x60000 (3.6e9 px) with no pixel data.
	bomb := craftPNGHeader(t, 60000, 60000)
	require.True(t, DeclaredPixelsExceedCap(bomb),
		"the cap comparison itself must fire on the header alone")

	_, err := NormalizeAvatar(bomb)
	require.ErrorIs(t, err, ErrImageTooLarge)
}

func TestNormalizeAvatar_RejectsBytesThatAreNotAnImage(t *testing.T) {
	_, err := NormalizeAvatar([]byte("this is not an image"))
	require.ErrorIs(t, err, ErrUnreadableImage)
}

// EXIF is absent because the output was re-encoded from pixels. This asserts
// the OUTPUT does not carry the marker, which is the property that matters —
// a test that only checked the input had one would prove nothing.
func TestNormalizeAvatar_OutputCarriesNoEXIF(t *testing.T) {
	withEXIF := jpegWithEXIF(t)
	require.Contains(t, string(withEXIF), "Exif", "fixture must actually carry EXIF")

	out, err := NormalizeAvatar(withEXIF)
	require.NoError(t, err)
	require.NotContains(t, string(out), "Exif")
	require.NotContains(t, string(out), "GPS")
}

// A non-square input is centre-cropped, not squashed. A squashed face in a
// 30px circle is the defect this prevents.
func TestNormalizeAvatar_CropsRatherThanSquashes(t *testing.T) {
	out, err := NormalizeAvatar(pngBytes(t, 1000, 500))
	require.NoError(t, err)
	cfg, _, err := image.DecodeConfig(bytes.NewReader(out))
	require.NoError(t, err)
	require.Equal(t, cfg.Width, cfg.Height)
}

func TestNormalizeAvatar_RejectsOversizedBytes(t *testing.T) {
	_, err := NormalizeAvatar(make([]byte, MaxAvatarBytes+1))
	require.ErrorIs(t, err, ErrImageTooLarge)
}

// craftPNGHeader builds a structurally valid PNG IHDR declaring w x h with no
// image data, which is exactly the shape of a decode bomb.
func craftPNGHeader(t *testing.T, w, h uint32) []byte {
	t.Helper()
	var buf bytes.Buffer
	buf.Write([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a})
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], w)
	binary.BigEndian.PutUint32(ihdr[4:8], h)
	ihdr[8], ihdr[9], ihdr[10], ihdr[11], ihdr[12] = 8, 6, 0, 0, 0 // 8-bit RGBA
	binary.Write(&buf, binary.BigEndian, uint32(len(ihdr)))
	chunk := append([]byte("IHDR"), ihdr...)
	buf.Write(chunk)
	binary.Write(&buf, binary.BigEndian, crc32.ChecksumIEEE(chunk))
	return buf.Bytes()
}

// jpegWithEXIF produces a JPEG carrying an APP1/Exif segment, so the
// no-EXIF-on-output assertion has something real to be the absence of.
func jpegWithEXIF(t *testing.T) []byte {
	t.Helper()
	var base bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 800, 800))
	require.NoError(t, jpeg.Encode(&base, img, nil))
	b := base.Bytes()

	// APP1 marker, length, "Exif\0\0", then a token standing in for GPS data.
	payload := append([]byte("Exif\x00\x00"), []byte("GPSLatitudeRefN")...)
	seg := []byte{0xFF, 0xE1, byte((len(payload) + 2) >> 8), byte((len(payload) + 2) & 0xFF)}
	seg = append(seg, payload...)

	out := append([]byte{}, b[:2]...) // SOI
	out = append(out, seg...)
	out = append(out, b[2:]...)
	return out
}
