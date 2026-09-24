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
  static let reminders = URL(string: "ShareMedia://TasksWidget")!
  static let newReminder = URL(string: "ShareMedia://NewTaskWidget")!

  static func reminder(id: String) -> URL {
    var components = URLComponents()
    components.scheme = "ShareMedia"
    components.host = "TaskWidget"
    components.queryItems = [URLQueryItem(name: "id", value: id)]
    return components.url ?? reminders
  }

  static func complete(id: String) -> URL {
    var components = URLComponents()
    components.scheme = "ShareMedia"
    components.host = "CompleteTaskWidget"
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
  let privacyHidden: Bool?
  let updatedAt: Double
  let generatedForDate: String
  let generatedForTimeZone: String
  let utcOffsetMinutes: Int
  let count: Int
  let appearance: String
  let accentLight: String
  let accentDark: String
  let tasks: [ReminderSnapshotItem]
}

private struct ReminderSnapshotItem: Codable, Identifiable {
  let id: String
  let title: String
  let dueDate: String?
  let dueTime: String?
  let flagged: Bool
  let priority: String
}

private enum ReminderSnapshotState {
  case unavailable
  case available(ReminderSnapshot)
}

private enum TaskWidgetClock {
  static var calendar: Calendar {
    var value = Calendar(identifier: .gregorian)
    value.timeZone = .autoupdatingCurrent
    return value
  }

  static func localDate(_ date: Date) -> String {
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
  }

  static func utcOffsetMinutes(_ date: Date) -> Int {
    TimeZone.autoupdatingCurrent.secondsFromGMT(for: date) / 60
  }

  static func normalizedTimeZone(_ identifier: String) -> String {
    switch identifier {
    case "UTC", "Etc/UTC", "Etc/GMT", "GMT": return "UTC"
    default: return identifier
    }
  }

  static func isFresh(_ snapshot: ReminderSnapshot, at date: Date) -> Bool {
    if snapshot.privacyHidden == true { return true }
    return snapshot.generatedForDate == localDate(date)
      && snapshot.utcOffsetMinutes == utcOffsetMinutes(date)
      && (snapshot.generatedForTimeZone.isEmpty
        || normalizedTimeZone(snapshot.generatedForTimeZone)
          == normalizedTimeZone(TimeZone.autoupdatingCurrent.identifier))
  }

  static func nextMidnight(after date: Date) -> Date {
    let nextDay = calendar.date(byAdding: .day, value: 1, to: date) ?? date.addingTimeInterval(86400)
    return calendar.startOfDay(for: nextDay)
  }

  static func dueInstant(_ task: ReminderSnapshotItem) -> Date? {
    guard let dueDate = task.dueDate, let dueTime = task.dueTime else { return nil }
    let day = dueDate.split(separator: "-").compactMap { Int($0) }
    let time = dueTime.split(separator: ":").compactMap { Int($0) }
    guard day.count == 3, time.count == 2 else { return nil }
    return calendar.date(from: DateComponents(
      year: day[0], month: day[1], day: day[2], hour: time[0], minute: time[1]
    ))
  }

  static func isOverdue(_ task: ReminderSnapshotItem, at date: Date) -> Bool {
    guard let dueDate = task.dueDate else { return false }
    let today = localDate(date)
    if dueDate < today { return true }
    if dueDate > today { return false }
    guard let dueInstant = dueInstant(task) else { return false }
    return dueInstant < date
  }
}

private enum ReminderSnapshotStore {
  private static let filename = "reminder-widget-snapshot.json"

  static func load(at now: Date = Date()) -> ReminderSnapshotState {
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
      snapshot.schemaVersion == 3,
      snapshot.count >= 0,
      TaskWidgetClock.isFresh(snapshot, at: now)
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
    let now = Date()
    let state = context.isPreview
      ? Self.previewEntry.state
      : ReminderSnapshotStore.load(at: now)
    completion(ReminderEntry(date: now, state: state))
  }

  func getTimeline(
    in context: Context,
    completion: @escaping (Timeline<ReminderEntry>) -> Void
  ) {
    let now = Date()
    let state = ReminderSnapshotStore.load(at: now)
    let nextMidnight = TaskWidgetClock.nextMidnight(after: now)
    var entries = [ReminderEntry(date: now, state: state)]
    if case let .available(snapshot) = state {
      let dueChanges = Set(snapshot.tasks.compactMap(TaskWidgetClock.dueInstant).map {
        $0.addingTimeInterval(1)
      }.filter { $0 > now && $0 < nextMidnight })
      entries.append(contentsOf: dueChanges.sorted().map {
        ReminderEntry(date: $0, state: state)
      })
    }
    // This entry hides yesterday's Tasks even if WidgetKit delays a reload.
    let midnightState: ReminderSnapshotState
    if case let .available(snapshot) = state, snapshot.privacyHidden == true {
      midnightState = state
    } else {
      midnightState = .unavailable
    }
    entries.append(ReminderEntry(date: nextMidnight, state: midnightState))
    let periodicRefresh = now.addingTimeInterval(15 * 60)
    completion(
      Timeline(
        entries: entries,
        policy: .after(min(nextMidnight.addingTimeInterval(1), periodicRefresh))
      )
    )
  }

  static let previewEntry = makePreviewEntry()

  private static func makePreviewEntry() -> ReminderEntry {
    let now = Date()
    let today = TaskWidgetClock.localDate(now)
    let yesterday = TaskWidgetClock.localDate(
      TaskWidgetClock.calendar.date(byAdding: .day, value: -1, to: now) ?? now
    )
    let previewData: [(String, String, String)] = [
      ("1", "Review proposal", today),
      ("2", "Pick up groceries", today),
      ("3", "Call Alex", yesterday)
    ]
    var tasks: [ReminderSnapshotItem] = []
    for (id, title, dueDate) in previewData {
      tasks.append(
        ReminderSnapshotItem(
          id: id,
          title: title,
          dueDate: dueDate,
          dueTime: nil,
          flagged: id == "1",
          priority: "none"
        )
      )
    }

    let snapshot = ReminderSnapshot(
      schemaVersion: 3,
      privacyHidden: false,
      updatedAt: now.timeIntervalSince1970 * 1000,
      generatedForDate: today,
      generatedForTimeZone: TimeZone.autoupdatingCurrent.identifier,
      utcOffsetMinutes: TaskWidgetClock.utcOffsetMinutes(now),
      count: tasks.count,
      appearance: "system",
      accentLight: "#008837",
      accentDark: "#20A65A",
      tasks: tasks
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
    if case let .available(snapshot) = entry.state,
       TaskWidgetClock.isFresh(snapshot, at: max(entry.date, Date())) {
      return snapshot
    }
    return nil
  }

  private var visibleCount: Int {
    switch family {
    case .systemSmall: return 2
    case .systemMedium: return 4
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
          .accessibilityLabel(Text("New task"))
      }
      .buttonStyle(.plain)
    }
    .padding(family == .systemSmall ? 11 : 13)
    .widgetSurface()
    .environment(\.colorScheme, effectiveColorScheme)
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
          Text("Tasks · Today")
            .font(.system(size: family == .systemSmall ? 9 : 10.5))
            .foregroundStyle(.secondary)
        }
        .lineLimit(1)

        Spacer(minLength: 4)

        if let snapshot, snapshot.privacyHidden != true {
          Text("\(snapshot.count)")
            .font(.system(size: family == .systemSmall ? 11 : 12, weight: .semibold))
            .foregroundStyle(.primary)
            .padding(.horizontal, family == .systemSmall ? 8 : 10)
            .frame(height: family == .systemSmall ? 23 : 25)
            .background(accent.opacity(effectiveColorScheme == .dark ? 0.28 : 0.16))
            .clipShape(Capsule())
            .accessibilityLabel(Text("\(snapshot.count) tasks today"))
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder private var content: some View {
    if let snapshot {
      if snapshot.privacyHidden == true {
        emptyState(title: "Tasks hidden by App Lock")
      } else if snapshot.count == 0 {
        emptyState(title: "No tasks today")
      } else {
        reminderLayout(Array(snapshot.tasks.prefix(visibleCount)))
      }
    } else {
      emptyState(title: "Open Notesnook to refresh tasks")
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
    VStack(spacing: 0) {
      ForEach(Array(reminders.enumerated()), id: \.element.id) { index, reminder in
        ReminderRow(
          reminder: reminder,
          referenceDate: max(entry.date, Date()),
          accent: accent,
          compact: family == .systemSmall,
          drawDivider: index < reminders.count - 1
        )
      }
      Spacer(minLength: plusSize - 2)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
  }
}

private struct ReminderRow: View {
  let reminder: ReminderSnapshotItem
  let referenceDate: Date
  let accent: Color
  let compact: Bool
  let drawDivider: Bool

  private var isOverdue: Bool {
    TaskWidgetClock.isOverdue(reminder, at: max(referenceDate, Date()))
  }

  var body: some View {
    HStack(spacing: compact ? 6 : 9) {
      Link(destination: WidgetURLs.complete(id: reminder.id)) {
        Image(systemName: "circle")
          .font(.system(size: compact ? 18 : 21))
          .foregroundStyle(accent)
          .frame(width: compact ? 24 : 30, height: compact ? 28 : 34)
          .contentShape(Rectangle())
      }
      .accessibilityLabel(Text("Complete \(reminder.title)"))

      Link(destination: WidgetURLs.reminder(id: reminder.id)) {
      VStack(alignment: .leading, spacing: compact ? 1 : 2) {
        HStack(spacing: compact ? 3 : 4) {
          if reminder.flagged {
            Image(systemName: "flag.fill")
              .font(.system(size: compact ? 10 : 12, weight: .semibold))
              .foregroundStyle(Color(UIColor.systemOrange))
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
      .accessibilityLabel(accessibilityLabel)
    }
    .buttonStyle(.plain)
  }

  private var accessibilityLabel: String {
    if isOverdue {
      return "\(String(localized: "Overdue")), \(reminder.title), \(secondaryText)"
    }
    return "\(reminder.title), \(secondaryText)"
  }

  private var secondaryText: String {
    if isOverdue { return String(localized: "Overdue") }
    if let time = reminder.dueTime { return "\(String(localized: "Today")) · \(time)" }
    return String(localized: "Today")
  }
}

private struct ReminderWidget: Widget {
  let kind = "ReminderWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: ReminderProvider()) { entry in
      ReminderWidgetEntryView(entry: entry)
    }
    .configurationDisplayName("Tasks")
    .description("See today's tasks, complete tasks, and create a task.")
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
