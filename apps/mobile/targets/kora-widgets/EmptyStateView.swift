import SwiftUI

struct EmptyStateView: View {
  let title: String
  let detail: String

  var body: some View {
    VStack(spacing: 4) {
      Text(title)
        .font(.headline)
        .foregroundStyle(WidgetTheme.ink)
      Text(detail)
        .font(.caption)
        .multilineTextAlignment(.center)
        .foregroundStyle(WidgetTheme.mut)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
