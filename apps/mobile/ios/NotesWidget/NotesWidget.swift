//
//  NotesWidget.swift
//  NotesWidget
//
//  Created by Ammar Ahmed on 25/02/2021.
//

import SwiftUI
import UIKit
import WidgetKit

private enum WidgetURLs {
  static let quickNote = URL(string: "ShareMedia://QuickNoteWidget")!
  static let reminders = URL(string: "ShareMedia://RemindersWidget")!
  static let newReminder = URL(string: "ShareMedia://NewReminderWidget")!

  static func reminder(id: String) -> URL {
    var components = URLComponents()
    components.scheme = "ShareMedia"
    components.host = "ReminderWidget"
    components.queryItems = [URLQueryItem(name: "id", value: id)]
    return components.url ?? reminders
  }
}

// MARK: - Existing Quick Note widget

private struct QuickNoteEntry: TimelineEntry {
  let date: Date
}

private struct QuickNoteProvider: TimelineProvider {
  func placeholder(in context: Context) -> QuickNoteEntry {
    QuickNoteEntry(date: Date())
  }

  func getSnapshot(
    in context: Context,
    completion: @escaping (QuickNoteEntry) -> Void
  ) {
    completion(QuickNoteEntry(date: Date()))
  }

  func getTimeline(
    in context: Context,
    completion: @escaping (Timeline<QuickNoteEntry>) -> Void
  ) {
    completion(Timeline(entries: [QuickNoteEntry(date: Date())], policy: .never))
  }
}

private struct QuickNoteEntryView: View {
  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: "plus")
        .font(.system(size: 42, weight: .light))
      Text("Add a quick note")
        .font(.system(size: 14))
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .widgetSurface()
    .widgetURL(WidgetURLs.quickNote)
  }
}

private struct QuickNoteWidget: Widget {
  let kind = "NotesWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: QuickNoteProvider()) { _ in
      QuickNoteEntryView()
    }
    .configurationDisplayName("Quick Note")
    .description("A widget to add notes quickly.")
  }
}

// MARK: - Reminder snapshot

private struct ReminderSnapshot: Codable {
  let schemaVersion: Int
  let updatedAt: Double
  let count: Int
  let appearance: String
  let accentLight: String
  let accentDark: String
  let reminders: [ReminderSnapshotItem]
}

private struct ReminderSnapshotItem: Codable, Identifiable {
  let id: String
  let title: String
  let timestamp: Double?
  let displayKind: String?
}

private enum ReminderSnapshotState {
  case unavailable
  case available(ReminderSnapshot)
}

private enum ReminderSnapshotStore {
  private static let filename = "reminder-widget-snapshot.json"

  static func load() -> ReminderSnapshotState {
    guard
      let appGroup = Bundle.main.object(forInfoDictionaryKey: "appGroupId") as? String,
      !appGroup.isEmpty,
      let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroup
      )
    else {
      return .unavailable
    }

    let url = container.appendingPathComponent(filename, isDirectory: false)
    guard
      let data = try? Data(contentsOf: url),
      let snapshot = try? JSONDecoder().decode(ReminderSnapshot.self, from: data),
      snapshot.schemaVersion == 1,
      snapshot.count >= 0
    else {
      return .unavailable
    }
    return .available(snapshot)
  }
}

private struct ReminderEntry: TimelineEntry {
  let date: Date
  let state: ReminderSnapshotState
}

private struct ReminderProvider: TimelineProvider {
  func placeholder(in context: Context) -> ReminderEntry {
    Self.previewEntry
  }

  func getSnapshot(
    in context: Context,
    completion: @escaping (ReminderEntry) -> Void
  ) {
    let state = context.isPreview
      ? Self.previewEntry.state
      : ReminderSnapshotStore.load()
    completion(ReminderEntry(date: Date(), state: state))
  }

  func getTimeline(
    in context: Context,
    completion: @escaping (Timeline<ReminderEntry>) -> Void
  ) {
    let now = Date()
    let entry = ReminderEntry(date: now, state: ReminderSnapshotStore.load())
    let nextMidnight = Calendar.current.startOfDay(
      for: Calendar.current.date(byAdding: .day, value: 1, to: now) ?? now
    )
    let periodicRefresh = now.addingTimeInterval(15 * 60)
    completion(
      Timeline(
        entries: [entry],
        policy: .after(min(nextMidnight, periodicRefresh))
      )
    )
  }

  static let previewEntry = makePreviewEntry()

  private static func makePreviewEntry() -> ReminderEntry {
    let now = Date()
    let previewData: [(String, String, TimeInterval)] = [
      ("1", "Unify Router", 60 * 60),
      ("2", "Apple TV", 5 * 60 * 60),
      ("3", "Decken Würfel", 23 * 60 * 60),
      ("4", "Netzwerk prüfen", 8 * 60 * 60),
      ("5", "Versicherung", 2 * 24 * 60 * 60),
      ("6", "Einkauf", 2 * 24 * 60 * 60 + 6 * 60 * 60),
      ("7", "Stromzähler", 3 * 24 * 60 * 60),
      ("8", "Oma Handy Konto", 4 * 24 * 60 * 60),
      ("9", "Termin bestätigen", 5 * 24 * 60 * 60),
      ("10", "Unterlagen vorbereiten", 6 * 24 * 60 * 60)
    ]
    var reminders: [ReminderSnapshotItem] = []
    for (id, title, offset) in previewData {
      reminders.append(
        ReminderSnapshotItem(
          id: id,
          title: title,
          timestamp: (now.timeIntervalSince1970 + offset) * 1000,
          displayKind: nil
        )
      )
    }

    let snapshot = ReminderSnapshot(
      schemaVersion: 1,
      updatedAt: now.timeIntervalSince1970 * 1000,
      count: 12,
      appearance: "system",
      accentLight: "#008837",
      accentDark: "#20A65A",
      reminders: reminders
    )
    return ReminderEntry(date: now, state: .available(snapshot))
  }
}

// MARK: - Reminder UI

private struct ReminderWidgetEntryView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var colorScheme

  let entry: ReminderEntry

  private var snapshot: ReminderSnapshot? {
    if case let .available(snapshot) = entry.state { return snapshot }
    return nil
  }

  private var visibleCount: Int {
    switch family {
    case .systemSmall: return 2
    case .systemMedium: return 6
    case .systemLarge: return 8
    default: return 2
    }
  }

  private var accent: Color {
    let hex = effectiveColorScheme == .dark
      ? snapshot?.accentDark
      : snapshot?.accentLight
    return Color(hex: hex ?? "#008837")
  }

  private var effectiveColorScheme: ColorScheme {
    switch snapshot?.appearance {
    case "light": return .light
    case "dark": return .dark
    default: return colorScheme
    }
  }

  var body: some View {
    ZStack(alignment: .bottomTrailing) {
      VStack(spacing: family == .systemSmall ? 7 : 8) {
        header
        content
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)

      Link(destination: WidgetURLs.newReminder) {
        Image(systemName: "plus")
          .font(.system(size: plusSize * 0.55, weight: .medium))
          .foregroundStyle(.white)
          .frame(width: plusSize, height: plusSize)
          .background(accent)
          .clipShape(Circle())
          .accessibilityLabel(Text("New reminder"))
      }
      .buttonStyle(.plain)
    }
    .padding(family == .systemSmall ? 11 : 13)
    .widgetSurface()
    .environment(\.colorScheme, effectiveColorScheme)
    .widgetURL(WidgetURLs.reminders)
  }

  private var plusSize: CGFloat {
    family == .systemSmall ? 27 : 31
  }

  private var header: some View {
    Link(destination: WidgetURLs.reminders) {
      HStack(spacing: 8) {
        ZStack {
          RoundedRectangle(cornerRadius: family == .systemSmall ? 7 : 8)
            .fill(accent)
          Image("icon")
            .resizable()
            .scaledToFit()
            .padding(family == .systemSmall ? 5 : 6)
        }
        .frame(
          width: family == .systemSmall ? 25 : 29,
          height: family == .systemSmall ? 25 : 29
        )

        VStack(alignment: .leading, spacing: -1) {
          Text("Notesnook")
            .font(.system(size: family == .systemSmall ? 13 : 15, weight: .semibold))
            .foregroundStyle(.primary)
          Text("Reminders")
            .font(.system(size: family == .systemSmall ? 9 : 10.5))
            .foregroundStyle(.secondary)
        }
        .lineLimit(1)

        Spacer(minLength: 4)

        if let snapshot {
          Text("\(snapshot.count)")
            .font(.system(size: family == .systemSmall ? 11 : 12, weight: .semibold))
            .foregroundStyle(.primary)
            .padding(.horizontal, family == .systemSmall ? 8 : 10)
            .frame(height: family == .systemSmall ? 23 : 25)
            .background(accent.opacity(effectiveColorScheme == .dark ? 0.28 : 0.16))
            .clipShape(Capsule())
            .accessibilityLabel(Text("\(snapshot.count) active reminders"))
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder private var content: some View {
    switch entry.state {
    case .unavailable:
      emptyState(title: "No data")
    case let .available(snapshot):
      if snapshot.count == 0 {
        emptyState(title: "No active reminders")
      } else {
        reminderLayout(Array(snapshot.reminders.prefix(visibleCount)))
      }
    }
  }

  private func emptyState(title: LocalizedStringKey) -> some View {
    Text(title)
      .font(.system(size: family == .systemSmall ? 11 : 13, weight: .medium))
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
      .padding(.bottom, plusSize)
  }

  @ViewBuilder private func reminderLayout(
    _ reminders: [ReminderSnapshotItem]
  ) -> some View {
    if family == .systemSmall {
      VStack(spacing: 0) {
        ForEach(Array(reminders.enumerated()), id: \.element.id) { index, reminder in
          ReminderRow(
            reminder: reminder,
            compact: true,
            drawDivider: index < reminders.count - 1
          )
        }
        Spacer(minLength: plusSize - 2)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    } else {
      let rowsPerColumn = family == .systemMedium ? 3 : 4
      HStack(alignment: .top, spacing: 11) {
        reminderColumn(
          Array(reminders.prefix(rowsPerColumn)),
          compact: family == .systemMedium,
          protectLastRow: false
        )
        Rectangle()
          .fill(Color.secondary.opacity(0.18))
          .frame(width: 0.5)
        reminderColumn(
          Array(reminders.dropFirst(rowsPerColumn).prefix(rowsPerColumn)),
          compact: family == .systemMedium,
          protectLastRow: true
        )
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
  }

  private func reminderColumn(
    _ reminders: [ReminderSnapshotItem],
    compact: Bool,
    protectLastRow: Bool
  ) -> some View {
    VStack(spacing: 0) {
      ForEach(Array(reminders.enumerated()), id: \.element.id) { index, reminder in
        ReminderRow(
          reminder: reminder,
          compact: compact,
          drawDivider: index < reminders.count - 1
        )
        .padding(
          .trailing,
          protectLastRow && index == reminders.count - 1 ? plusSize + 4 : 0
        )
      }
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
  }
}

private struct ReminderRow: View {
  let reminder: ReminderSnapshotItem
  let compact: Bool
  let drawDivider: Bool

  var body: some View {
    Link(destination: WidgetURLs.reminder(id: reminder.id)) {
      VStack(alignment: .leading, spacing: compact ? 1 : 2) {
        HStack(spacing: compact ? 3 : 4) {
          if isOverdue {
            Image(systemName: "bell.fill")
              .font(.system(size: compact ? 10 : 12, weight: .semibold))
              .foregroundStyle(Color(UIColor.systemRed))
              .frame(width: compact ? 11 : 13)
              .accessibilityHidden(true)
          }

          Text(reminder.title)
            .font(.system(size: compact ? 12 : 14, weight: .medium))
            .foregroundStyle(.primary)
            .lineLimit(1)
            .truncationMode(.tail)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        Text(secondaryText)
          .font(.system(size: compact ? 9.5 : 11))
          .foregroundStyle(
            isOverdue ? Color(UIColor.systemRed) : Color.secondary
          )
          .lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, compact ? 4 : 7)
      .contentShape(Rectangle())
      .overlay(alignment: .bottom) {
        if drawDivider {
          Rectangle()
            .fill(Color.secondary.opacity(0.18))
            .frame(height: 0.5)
        }
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(accessibilityLabel)
  }

  private var isOverdue: Bool {
    guard let milliseconds = reminder.timestamp else { return false }
    return Date(timeIntervalSince1970: milliseconds / 1000) < Date()
  }

  private var accessibilityLabel: String {
    if isOverdue {
      return "\(String(localized: "Overdue reminder")), \(reminder.title), \(secondaryText)"
    }
    return "\(reminder.title), \(secondaryText)"
  }

  private var secondaryText: String {
    guard let milliseconds = reminder.timestamp else {
      return String(localized: "Ongoing")
    }
    let date = Date(timeIntervalSince1970: milliseconds / 1000)
    let calendar = Calendar.current
    let dateText: String
    if calendar.isDateInToday(date) {
      dateText = String(localized: "Today")
    } else if calendar.isDateInTomorrow(date) {
      dateText = String(localized: "Tomorrow")
    } else {
      let formatter = DateFormatter()
      formatter.locale = .current
      formatter.setLocalizedDateFormatFromTemplate("d MMM")
      dateText = formatter.string(from: date)
    }

    let timeFormatter = DateFormatter()
    timeFormatter.locale = .current
    timeFormatter.timeStyle = .short
    timeFormatter.dateStyle = .none
    return "\(dateText) • \(timeFormatter.string(from: date))"
  }
}

private struct ReminderWidget: Widget {
  let kind = "ReminderWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: ReminderProvider()) { entry in
      ReminderWidgetEntryView(entry: entry)
    }
    .configurationDisplayName("Reminders")
    .description("See upcoming reminders and create a new reminder.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}

// MARK: - Shared styling

private struct WidgetSurface: View {
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    LinearGradient(
      colors: colorScheme == .dark
        ? [Color(UIColor.secondarySystemBackground), Color(UIColor.systemBackground)]
        : [Color(UIColor.systemBackground), Color(UIColor.secondarySystemBackground)],
      startPoint: .topLeading,
      endPoint: .bottomTrailing
    )
  }
}

private struct WidgetSurfaceModifier: ViewModifier {
  @ViewBuilder func body(content: Content) -> some View {
    if #available(iOSApplicationExtension 17.0, *) {
      content.containerBackground(for: .widget) { WidgetSurface() }
    } else {
      content.background(WidgetSurface())
    }
  }
}

private extension View {
  func widgetSurface() -> some View {
    modifier(WidgetSurfaceModifier())
  }
}

private extension Color {
  init(hex: String) {
    let sanitized = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
    var value: UInt64 = 0
    Scanner(string: sanitized).scanHexInt64(&value)
    guard sanitized.count == 6 else {
      self = Color.accentColor
      return
    }
    self.init(
      red: Double((value >> 16) & 0xff) / 255,
      green: Double((value >> 8) & 0xff) / 255,
      blue: Double(value & 0xff) / 255
    )
  }
}

@main
struct NotesWidgetBundle: WidgetBundle {
  var body: some Widget {
    QuickNoteWidget()
    ReminderWidget()
  }
}

struct NotesWidget_Previews: PreviewProvider {
  static var previews: some View {
    Group {
      ReminderWidgetEntryView(entry: ReminderProvider.previewEntry)
        .previewContext(WidgetPreviewContext(family: .systemSmall))
      ReminderWidgetEntryView(entry: ReminderProvider.previewEntry)
        .previewContext(WidgetPreviewContext(family: .systemMedium))
      ReminderWidgetEntryView(entry: ReminderProvider.previewEntry)
        .previewContext(WidgetPreviewContext(family: .systemLarge))
    }
  }
}
