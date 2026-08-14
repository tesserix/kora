import SwiftUI

/// The tick gauge. Geometry comes entirely from DialGeometry (pure, tested);
/// this view only draws it.
///
/// The dial owns its readout rather than being stacked under one by the
/// caller: the readout has to be placed against the HUB, and only the dial
/// knows where the hub landed (issue #168).
struct DialView<Readout: View>: View {
  let fraction: Double
  let isOverTarget: Bool
  private let readout: Readout

  init(fraction: Double, isOverTarget: Bool, @ViewBuilder readout: () -> Readout) {
    self.fraction = fraction
    self.isOverTarget = isOverTarget
    self.readout = readout()
  }

  var body: some View {
    GeometryReader { geo in
      let side = min(geo.size.width, geo.size.height)
      let radius = side / 2
      let center = CGPoint(x: geo.size.width / 2, y: side / 2)

      ZStack {
        ForEach(0..<DialGeometry.tickCount, id: \.self) { index in
          tick(index: index, center: center, radius: radius)
        }
        needle(center: center, radius: radius)
        readoutBox(center: center, radius: radius)
      }
    }
  }

  private func tick(index: Int, center: CGPoint, radius: CGFloat) -> some View {
    let major = DialGeometry.isMajor(index: index)
    let lit = DialGeometry.isLit(index: index, fraction: fraction)
    let redline = DialGeometry.isRedline(index: index)
    let lengthFraction = major ? DialGeometry.majorTickLengthFraction : DialGeometry.minorTickLengthFraction
    let widthFraction = major ? DialGeometry.majorTickWidthFraction : DialGeometry.minorTickWidthFraction
    let length = radius * CGFloat(lengthFraction)
    let angle = Angle(degrees: DialGeometry.angleDegrees(index: index))

    // Redline ticks tint accent only once the value has actually reached
    // them — an unlit redline is still just an unlit tick.
    let colour: Color = lit ? (redline && isOverTarget ? WidgetTheme.accent : WidgetTheme.ink)
                            : WidgetTheme.tick

    return Path { path in
      path.move(to: point(center: center, radius: radius, angle: angle))
      path.addLine(to: point(center: center, radius: radius - length, angle: angle))
    }
    .stroke(colour, style: StrokeStyle(lineWidth: radius * CGFloat(widthFraction), lineCap: .round))
  }

  private func needle(center: CGPoint, radius: CGFloat) -> some View {
    let angle = Angle(degrees: DialGeometry.needleAngleDegrees(fraction: fraction))
    let hubDiameter = CGFloat(DialGeometry.hubRadius(dialRadius: Double(radius))) * 2
    return ZStack {
      Path { path in
        path.move(to: center)
        path.addLine(to: point(center: center,
                               radius: radius * CGFloat(DialGeometry.needleLengthFraction),
                               angle: angle))
      }
      .stroke(WidgetTheme.accent,
              style: StrokeStyle(lineWidth: radius * CGFloat(DialGeometry.needleWidthFraction), lineCap: .round))

      Circle()
        .fill(WidgetTheme.accent)
        .frame(width: hubDiameter, height: hubDiameter)
        .position(center)
    }
  }

  /// The readout sits in the clear band below the hub, sized by the dial so a
  /// wide hero ("10,000") never reaches the tick ring and a narrow one ("—")
  /// never lands on the hub.
  private func readoutBox(center: CGPoint, radius: CGFloat) -> some View {
    let dialRadius = Double(radius)
    let width = CGFloat(DialGeometry.readoutMaxWidth(dialRadius: dialRadius))
    let height = CGFloat(DialGeometry.readoutMaxHeight(dialRadius: dialRadius))
    let top = CGFloat(DialGeometry.readoutTopOffset(dialRadius: dialRadius))

    return readout
      .frame(width: width, height: height)
      .position(x: center.x, y: center.y + top + height / 2)
  }

  private func point(center: CGPoint, radius: CGFloat, angle: Angle) -> CGPoint {
    CGPoint(x: center.x + radius * cos(angle.radians),
            y: center.y + radius * sin(angle.radians))
  }
}
