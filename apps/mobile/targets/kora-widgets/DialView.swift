import SwiftUI

/// The tick gauge. Geometry comes entirely from DialGeometry (pure, tested);
/// this view only draws it.
struct DialView: View {
  let fraction: Double
  let isOverTarget: Bool

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
      }
    }
  }

  private func tick(index: Int, center: CGPoint, radius: CGFloat) -> some View {
    let major = DialGeometry.isMajor(index: index)
    let lit = DialGeometry.isLit(index: index, fraction: fraction)
    let redline = DialGeometry.isRedline(index: index)
    let length: CGFloat = major ? radius * 0.21 : radius * 0.13
    let angle = Angle(degrees: DialGeometry.angleDegrees(index: index))

    // Redline ticks tint accent only once the value has actually reached
    // them — an unlit redline is still just an unlit tick.
    let colour: Color = lit ? (redline && isOverTarget ? WidgetTheme.accent : WidgetTheme.ink)
                            : WidgetTheme.tick

    return Path { path in
      path.move(to: point(center: center, radius: radius, angle: angle))
      path.addLine(to: point(center: center, radius: radius - length, angle: angle))
    }
    .stroke(colour, style: StrokeStyle(lineWidth: major ? radius * 0.05 : radius * 0.035, lineCap: .round))
  }

  private func needle(center: CGPoint, radius: CGFloat) -> some View {
    let angle = Angle(degrees: DialGeometry.needleAngleDegrees(fraction: fraction))
    return ZStack {
      Path { path in
        path.move(to: center)
        path.addLine(to: point(center: center, radius: radius * 0.68, angle: angle))
      }
      .stroke(WidgetTheme.accent, style: StrokeStyle(lineWidth: radius * 0.062, lineCap: .round))

      Circle()
        .fill(WidgetTheme.accent)
        .frame(width: radius * 0.16, height: radius * 0.16)
        .position(center)
    }
  }

  private func point(center: CGPoint, radius: CGFloat, angle: Angle) -> CGPoint {
    CGPoint(x: center.x + radius * cos(angle.radians),
            y: center.y + radius * sin(angle.radians))
  }
}
