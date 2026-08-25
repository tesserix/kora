package imageproc

import (
	"image"
	"image/color"
)

// BoxAverageResize maps each destination pixel to the AVERAGE of the source
// rectangle it covers (kora#365).
//
// It replaces a nearest-neighbour resize, whose justification in this file
// had the reasoning backwards: it argued point sampling was acceptable
// because the input is "rendered UI text on a clean background, not a
// photograph". Crisp thin-stroke text is precisely where point sampling does
// the MOST damage — it discards pixels outright, so at the ~0.64 factor a
// 736x1600 screenshot takes, roughly a third of rows and columns vanish and
// thin glyph strokes break up. A photograph's soft gradients are what
// tolerate point sampling.
//
// Averaging is also what this repo already decided elsewhere for the same
// reason: apps/mobile/shots-golden/README.md records goldens as "box-averaged
// 3x3 down" from the native capture, chosen because the content is UI text.
//
// Source rectangles are computed from destination EDGES rather than centres,
// so every source pixel contributes to exactly one destination pixel and none
// is skipped -- that coverage property is the whole point.
func BoxAverageResize(src image.Image, newWidth, newHeight int) *image.RGBA {
	srcBounds := src.Bounds()
	srcWidth, srcHeight := srcBounds.Dx(), srcBounds.Dy()

	dst := image.NewRGBA(image.Rect(0, 0, newWidth, newHeight))
	xRatio := float64(srcWidth) / float64(newWidth)
	yRatio := float64(srcHeight) / float64(newHeight)

	for dy := 0; dy < newHeight; dy++ {
		y0 := srcBounds.Min.Y + int(float64(dy)*yRatio)
		y1 := srcBounds.Min.Y + int(float64(dy+1)*yRatio)
		if y1 <= y0 {
			// Upscaling, or a ratio below 1 per axis: still average at
			// least one row rather than producing an empty box.
			y1 = y0 + 1
		}
		if y1 > srcBounds.Max.Y {
			y1 = srcBounds.Max.Y
		}
		for dx := 0; dx < newWidth; dx++ {
			x0 := srcBounds.Min.X + int(float64(dx)*xRatio)
			x1 := srcBounds.Min.X + int(float64(dx+1)*xRatio)
			if x1 <= x0 {
				x1 = x0 + 1
			}
			if x1 > srcBounds.Max.X {
				x1 = srcBounds.Max.X
			}

			var rSum, gSum, bSum, aSum uint64
			var n uint64
			for sy := y0; sy < y1; sy++ {
				for sx := x0; sx < x1; sx++ {
					r, g, b, a := src.At(sx, sy).RGBA()
					// RGBA() returns 16-bit premultiplied values; >>8 puts
					// them back in the 8-bit space image.RGBA stores.
					rSum += uint64(r >> 8)
					gSum += uint64(g >> 8)
					bSum += uint64(b >> 8)
					aSum += uint64(a >> 8)
					n++
				}
			}
			if n == 0 {
				continue
			}
			dst.Set(dx, dy, color.RGBA{
				R: uint8(rSum / n),
				G: uint8(gSum / n),
				B: uint8(bSum / n),
				A: uint8(aSum / n),
			})
		}
	}
	return dst
}
