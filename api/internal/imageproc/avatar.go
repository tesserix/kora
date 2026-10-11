package imageproc

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
	_ "image/png" // format registration for image.Decode
)

const (
	// AvatarDimension is the stored square edge. 512 is four times the largest
	// on-screen size (72pt on profile, at 3x) so the picture stays sharp on a
	// Pro Max without storing a photograph.
	AvatarDimension = 512

	// MaxAvatarBytes matches the cap internal/bodyread/handler.go already
	// enforces, so the two upload paths refuse at the same size.
	MaxAvatarBytes = 8 << 20
)

var (
	ErrUnreadableImage = errors.New("imageproc: not a readable image")
	ErrImageTooLarge   = errors.New("imageproc: image is too large")
)

// NormalizeAvatar turns arbitrary user-supplied image bytes into a square JPEG
// of at most AvatarDimension on a side.
//
// Order matters and must not be tidied:
//
//  1. Byte cap, before anything reads the bytes.
//  2. HEADER-ONLY pixel cap, before image.Decode allocates for whatever
//     dimensions the header claims. See DeclaredPixelsExceedCap.
//  3. Centre-crop to square, so a face is cropped rather than squashed.
//  4. Box-average downscale. NOT nearest-neighbour, and NOT x/image/draw:
//     BoxAverageResize maps each destination pixel to the average of the source
//     rectangle it covers, which IS area resampling -- the right filter for a
//     large reduction of a photograph, and the one this repo already chose in
//     kora#365. x/image is not needed and is not added.
//  5. Re-encode as JPEG. This is HOW EXIF goes away, including the GPS
//     coordinates a selfie carries: re-encoding from pixels drops everything
//     that is not pixels, which is strictly more robust than removing the
//     metadata fields someone remembered to name.
//
// Unlike bodyread's downscaleForProvider, a failure here is FATAL rather than a
// fall back to the original bytes. There, downscaling is a cost optimisation
// and the original still works. Here, "return the original" would store an
// un-normalised, EXIF-carrying, arbitrarily large file -- the exact object this
// function exists to prevent.
func NormalizeAvatar(data []byte) ([]byte, error) {
	if len(data) > MaxAvatarBytes {
		return nil, ErrImageTooLarge
	}
	if DeclaredPixelsExceedCap(data) {
		return nil, ErrImageTooLarge
	}

	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, ErrUnreadableImage
	}

	square := centreCrop(img)
	edge := square.Bounds().Dx()
	if edge > AvatarDimension {
		square = BoxAverageResize(square, AvatarDimension, AvatarDimension)
	}

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, square, &jpeg.Options{Quality: 85}); err != nil {
		return nil, ErrUnreadableImage
	}
	return buf.Bytes(), nil
}

// centreCrop returns the largest centred square of img. Cropping rather than
// scaling both axes independently: every call site renders the result in a
// circle, and a squashed face in a 30px circle is worse than a tighter crop.
func centreCrop(img image.Image) image.Image {
	b := img.Bounds()
	edge := b.Dx()
	if b.Dy() < edge {
		edge = b.Dy()
	}
	x0 := b.Min.X + (b.Dx()-edge)/2
	y0 := b.Min.Y + (b.Dy()-edge)/2
	rect := image.Rect(x0, y0, x0+edge, y0+edge)

	type subImager interface {
		SubImage(image.Rectangle) image.Image
	}
	if si, ok := img.(subImager); ok {
		return si.SubImage(rect)
	}
	// Not every image.Image exposes SubImage; copy through BoxAverageResize at
	// 1:1, which is a no-op average over single-pixel boxes.
	return BoxAverageResize(img, edge, edge)
}
