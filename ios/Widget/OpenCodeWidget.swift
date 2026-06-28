// SPDX-License-Identifier: Apache-2.0
// Based on opencode-remote-android by giuliastro (Apache-2.0). Modified for iOS, 2026.
// Matrix phosphor re-theme for the home widget, lock-screen Live Activity,
// and Dynamic Island (compact / expanded / minimal). Fixes: compact pill overflow,
// asymmetric padding, clipped detail, undersized fonts. iOS 16.1+.
import WidgetKit
import SwiftUI

private let appGroup = "group.ai.opencode.remote.ios"
private let snapshotKey = "sessions_snapshot"

// MARK: - Matrix palette (matches web/src --mx-* tokens)
private enum Matrix {
  static let user    = Color(red: 0x00/255.0, green: 0xFF/255.0, blue: 0x41/255.0)   // #00FF41 phosphor green
  static let ai      = Color(red: 0x00/255.0, green: 0xE5/255.0, blue: 0xFF/255.0)   // #00E5FF cyan
  static let tool    = Color(red: 0xFF/255.0, green: 0xB0/255.0, blue: 0x00/255.0)   // #FFB000 amber
  static let bg      = Color(red: 0x02/255.0, green: 0x0A/255.0, blue: 0x06/255.0)   // #020A06
  static let surface = Color(red: 0x04/255.0, green: 0x14/255.0, blue: 0x0A/255.0, opacity: 0.60) // rgba(4,20,10,.60)
  static let border  = Color(red: 0x00/255.0, green: 0xAA/255.0, blue: 0x33/255.0)   // #0A3 active
  static let dim     = Color(red: 0x3A/255.0, green: 0x8A/255.0, blue: 0x55/255.0)   // #3A8A55
}

// MARK: - Status visuals
private func statusColor(_ status: String) -> Color {
  switch status {
  case "busy":  return Matrix.ai      // cyan "LIVE"
  case "retry": return Matrix.tool    // amber retry
  case "idle":  return Matrix.user    // green done
  default:      return Matrix.dim
  }
}
private func statusGlyph(_ status: String) -> String {
  switch status {
  case "busy":  return "terminal.fill"
  case "retry": return "exclamationmark.arrow.triangle.2.circlepath"
  case "idle":  return "checkmark.seal.fill"
  default:      return "terminal"
  }
}

// Snapshot shape written by the SharedSnapshot Capacitor plugin.
struct SessionsSnapshot: Codable {
  struct Session: Codable { let id: String; let title: String; let status: String; let updated: Double }
  let activeCount: Int
  let sessions: [Session]
  let updatedAt: Double
}

// MARK: - Home-screen widget

struct OpenCodeEntry: TimelineEntry {
  let date: Date
  let snapshot: SessionsSnapshot?
}

struct OpenCodeProvider: TimelineProvider {
  func placeholder(in context: Context) -> OpenCodeEntry { OpenCodeEntry(date: Date(), snapshot: nil) }
  func getSnapshot(in context: Context, completion: @escaping (OpenCodeEntry) -> Void) {
    completion(OpenCodeEntry(date: Date(), snapshot: read()))
  }
  func getTimeline(in context: Context, completion: @escaping (Timeline<OpenCodeEntry>) -> Void) {
    let entry = OpenCodeEntry(date: Date(), snapshot: read())
    completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(900))))
  }
  private func read() -> SessionsSnapshot? {
    guard let suite = UserDefaults(suiteName: appGroup), let data = suite.data(forKey: snapshotKey) else { return nil }
    return try? JSONDecoder().decode(SessionsSnapshot.self, from: data)
  }
}

struct OpenCodeWidgetView: View {
  var entry: OpenCodeEntry
  private var snap: SessionsSnapshot? { entry.snapshot }
  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(spacing: 6) {
        Image(systemName: "terminal.fill")
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(Matrix.user)
        Text("OpenCode")
          .font(.system(size: 13, weight: .bold, design: .monospaced))
          .foregroundStyle(Matrix.user)
        Spacer()
        if let n = snap?.activeCount, n > 0 {
          Text("● \(n)")
            .font(.system(size: 11, weight: .bold, design: .monospaced))
            .foregroundStyle(Matrix.ai)
        }
      }
      Rectangle().fill(Matrix.border.opacity(0.5)).frame(height: 1)
      if let sessions = snap?.sessions.prefix(3), !sessions.isEmpty {
        ForEach(Array(sessions), id: \.id) { s in
          HStack(spacing: 6) {
            Circle().fill(statusColor(s.status)).frame(width: 7, height: 7)
            Text(s.title.isEmpty ? s.id : s.title)
              .font(.system(size: 11, weight: .regular, design: .monospaced))
              .foregroundStyle(.white)
              .lineLimit(1)
              .truncationMode(.tail)
            Spacer(minLength: 4)
            if s.status == "busy" || s.status == "retry" {
              Text(s.status == "retry" ? "RETRY" : "LIVE")
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .foregroundStyle(statusColor(s.status))
            }
          }
        }
      } else {
        Text(snap == nil ? "awaiting link…" : "no session")
          .font(.system(size: 11, weight: .regular, design: .monospaced))
          .foregroundStyle(Matrix.dim)
          .lineLimit(2)
      }
      Spacer(minLength: 0)
    }
    .padding(10)
  }
}

struct OpenCodeHomeWidget: Widget {
  let kind = "OpenCodeHomeWidget"
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: OpenCodeProvider()) { entry in
      if #available(iOS 17.0, *) {
        OpenCodeWidgetView(entry: entry).containerBackground(for: .widget) {
          LinearGradient(colors: [Matrix.bg, Color(red: 0x04/255.0, green: 0x12/255.0, blue: 0x0A/255.0)],
                        startPoint: .top, endPoint: .bottom)
        }
      } else {
        OpenCodeWidgetView(entry: entry)
          .padding(.vertical, 4)
          .background(LinearGradient(colors: [Matrix.bg, Color(red: 0x04/255.0, green: 0x12/255.0, blue: 0x0A/255.0)],
                                     startPoint: .top, endPoint: .bottom))
      }
    }
    .configurationDisplayName("OpenCode Remote")
    .description("Matrix live session status.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

// MARK: - Progress bar (shown when progress >= 0)
private struct MatrixProgressBar: View {
  let progress: Double        // 0...1, or < 0 to hide
  var body: some View {
    GeometryReader { geo in
      let p = max(0, min(1, progress))
      ZStack(alignment: .leading) {
        RoundedRectangle(cornerRadius: 2)
          .fill(Matrix.border.opacity(0.25))
        RoundedRectangle(cornerRadius: 2)
          .fill(LinearGradient(colors: [Matrix.user, Matrix.ai], startPoint: .leading, endPoint: .trailing))
          .frame(width: max(3, geo.size.width * p))
          .shadow(color: Matrix.user.opacity(0.7), radius: 2.5)
      }
    }
    .frame(height: 4)
  }
}

// Subtle scanline texture for the expanded Dynamic Island (decorative, no perf cost).
private var scanlineOverlay: some View {
  LinearGradient(
    colors: [Matrix.bg.opacity(0.0), Matrix.bg.opacity(0.18), Matrix.bg.opacity(0.0)],
    startPoint: .top, endPoint: .bottom
  )
  .blendMode(.multiply)
  .opacity(0.5)
  .allowsHitTesting(false)
}

// MARK: - Live Activity (lock screen + Dynamic Island)

struct OpenCodeLiveActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: OpenCodeActivityAttributes.self) { context in
      lockScreenView(context.state)
    } dynamicIsland: { context in
      DynamicIsland {
        // Expanded — symmetric, readable mono, scanlines, progress bar.
        DynamicIslandExpandedRegion(.leading) {
          HStack(spacing: 4) {
            Image(systemName: statusGlyph(context.state.status))
              .font(.system(size: 13, weight: .bold))
              .foregroundStyle(statusColor(context.state.status))
              .shadow(color: statusColor(context.state.status).opacity(0.6), radius: 2)
          }
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(context.state.status == "busy" ? "LIVE"
               : context.state.status == "retry" ? "RETRY"
               : "DONE")
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .foregroundStyle(statusColor(context.state.status))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(statusColor(context.state.status).opacity(0.15),
                        in: RoundedRectangle(cornerRadius: 4))
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 5) {
            Text(context.state.title.isEmpty ? "session" : context.state.title)
              .font(.system(size: 12, weight: .bold, design: .monospaced))
              .foregroundStyle(Matrix.user)
              .lineLimit(1)
              .truncationMode(.tail)
              .frame(maxWidth: .infinity, alignment: .leading)
            Text(context.state.detail)
              .font(.system(size: 10, weight: .regular, design: .monospaced))
              .foregroundStyle(Matrix.dim)
              .lineLimit(2)
              .truncationMode(.tail)
              .frame(maxWidth: .infinity, alignment: .leading)
            if context.state.progress >= 0 {
              HStack(spacing: 6) {
                MatrixProgressBar(progress: context.state.progress)
                Text("\(Int((max(0, min(1, context.state.progress)) * 100).rounded()))%")
                  .font(.system(size: 9, weight: .bold, design: .monospaced))
                  .foregroundStyle(Matrix.ai)
                  .frame(minWidth: 30, alignment: .trailing)
              }
            }
          }
          .padding(.horizontal, 4)
          .padding(.vertical, 2)
          .background(scanlineOverlay)
        }
      } compactLeading: {
        // Compact: phosphor terminal glyph, centered.
        Image(systemName: "terminal.fill")
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(statusColor(context.state.status))
          .frame(width: 18, height: 18)
      } compactTrailing: {
        // BUGFIX: constrain width so a busy "LIVE"/progress never overflows the pill.
        // Only a glyph or 2-char status is shown; width is capped.
        Group {
          if context.state.progress >= 0 && context.state.status == "busy" {
            Text("\(Int((max(0, min(1, context.state.progress)) * 100).rounded()))%")
              .font(.system(size: 9, weight: .bold, design: .monospaced))
              .foregroundStyle(Matrix.ai)
              .frame(maxWidth: 30)
              .lineLimit(1)
              .truncationMode(.tail)
          } else {
            Text(context.state.status == "idle" ? "✓" : "●")
              .font(.system(size: 10, weight: .bold))
              .foregroundStyle(statusColor(context.state.status))
              .frame(maxWidth: 14)
          }
        }
      } minimal: {
        Image(systemName: "terminal.fill")
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(statusColor(context.state.status))
      }
    }
  }

  // Lock-screen card: translucent green glass surface, #0A3 border, progress.
  @ViewBuilder
  private func lockScreenView(_ state: OpenCodeActivityAttributes.ContentState) -> some View {
    HStack(spacing: 12) {
      Image(systemName: statusGlyph(state.status))
        .font(.system(size: 22, weight: .bold))
        .foregroundStyle(statusColor(state.status))
        .shadow(color: statusColor(state.status).opacity(0.6), radius: 3)
        .frame(width: 28)
      VStack(alignment: .leading, spacing: 3) {
        Text(state.title.isEmpty ? "session" : state.title)
          .font(.system(size: 14, weight: .bold, design: .monospaced))
          .foregroundStyle(Matrix.user)
          .lineLimit(1)
          .truncationMode(.tail)
        Text(state.detail)
          .font(.system(size: 11, weight: .regular, design: .monospaced))
          .foregroundStyle(Matrix.dim)
          .lineLimit(1)
          .truncationMode(.tail)
        if state.progress >= 0 {
          MatrixProgressBar(progress: state.progress)
            .padding(.top, 2)
        }
      }
      Spacer(minLength: 0)
      VStack(spacing: 2) {
        Text(state.status == "busy" ? "LIVE"
             : state.status == "retry" ? "RETRY"
             : "DONE")
          .font(.system(size: 9, weight: .bold, design: .monospaced))
          .foregroundStyle(statusColor(state.status))
      }
    }
    .padding(14)
    .background(
      RoundedRectangle(cornerRadius: 16)
        .fill(Matrix.surface)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 16)
        .strokeBorder(Matrix.border.opacity(0.55), lineWidth: 1)
    )
    .activityBackgroundTint(Color(red: 0x04/255.0, green: 0x14/255.0, blue: 0x0A/255.0, opacity: 0.80)) // rgba(4,20,10,.80)
    .activitySystemActionForegroundColor(Matrix.user)
  }
}

// MARK: - Bundle

@main
struct OpenCodeWidgetBundle: WidgetBundle {
  var body: some Widget {
    OpenCodeHomeWidget()
    OpenCodeLiveActivityWidget()
  }
}
