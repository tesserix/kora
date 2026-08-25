package imageproc

import (
	"image"
	"image/color"
	"testing"

	"github.com/stretchr/testify/require"
)

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

	dst := BoxAverageResize(src, 2, 1)
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
	dst := BoxAverageResize(src, 1, 1)
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
		dst := BoxAverageResize(src, 3, 2)
		r, g, b, _ := dst.At(2, 1).RGBA()
		require.EqualValues(t, 10, r>>8)
		require.EqualValues(t, 20, g>>8)
		require.EqualValues(t, 30, b>>8)
	})
}
