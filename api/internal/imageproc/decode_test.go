package imageproc

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"testing"

	"github.com/stretchr/testify/require"
)

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

// TestDeclaredPixelsExceedCap tests the cap comparison DIRECTLY, isolated
// from a caller's decode-failure fallback — a crafted header with no real
// pixel data would fail a full image.Decode regardless of whether the
// pixel-count guard is even present, which would silently mask a broken or
// deleted guard behind the same observable "unchanged output, no error"
// outcome in an end-to-end test. This test can only pass if
// DeclaredPixelsExceedCap itself does the right comparison.
func TestDeclaredPixelsExceedCap(t *testing.T) {
	require.True(t, DeclaredPixelsExceedCap(craftedHugePNG(t, 40000, 40000)),
		"40000x40000 (1.6B px) must exceed MaxDecodePixels (50M)")
	require.False(t, DeclaredPixelsExceedCap(craftedHugePNG(t, 1000, 1000)),
		"1000x1000 (1M px) must NOT exceed MaxDecodePixels (50M)")
	require.False(t, DeclaredPixelsExceedCap([]byte("not a png at all")),
		"an undecodable header must not be reported as over-cap — that is the caller's decode-failure path to own")
}
