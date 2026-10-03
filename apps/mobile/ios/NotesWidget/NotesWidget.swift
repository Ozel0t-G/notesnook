//
//  NotesWidget.swift
//  NotesWidget
//
//  Created by Ammar Ahmed on 25/02/2021.
//

import SwiftUI
import UIKit
import WidgetKit
import AppIntents
// ActivityKit and AlarmKit import on Mac Catalyst but their types are
// unavailable there, so the Live Activity surfaces are compiled out on Mac.
#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
import ActivityKit
#endif
#if canImport(AlarmKit) && !targetEnvironment(macCatalyst)
import AlarmKit
#endif

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

/// Presentation of the four smart lists the Tasks screen shows. The colors and
/// symbols mirror `SMART_LISTS` in `app/screens/tasks/index.tsx`.
private extension TaskWidgetList {
  var title: LocalizedStringKey {
    switch self {
    case .today: return "Today"
    case .scheduled: return "Scheduled"
    case .all: return "All"
    case .flagged: return "Flagged"
    }
  }

  var symbol: String {
    switch self {
    case .today, .scheduled: return "calendar"
    case .all: return "tray.fill"
    case .flagged: return "flag.fill"
    }
  }

  /// UIKit system colors so tinted and accented rendering modes keep working;
  /// `all` uses the app's dark gray tile color instead of a semantic gray.
  var color: Color {
    switch self {
    case .today: return Color(UIColor.systemBlue)
    case .scheduled: return Color(UIColor.systemRed)
    case .all: return Color(hex: "#636366")
    case .flagged: return Color(UIColor.systemOrange)
    }
  }
}

private struct ReminderEntry: TimelineEntry {
  let date: Date
  let state: ReminderSnapshotState
  let list: TaskWidgetList
}

/// The entries every provider shares: the snapshot now, one entry per due time
/// and per completion retry, midnight, and a periodic 15 minute refresh.
private func reminderTimeline(
  state: ReminderSnapshotState,
  list: TaskWidgetList,
  now: Date
) -> Timeline<ReminderEntry> {
  let nextMidnight = TaskWidgetClock.nextMidnight(after: now)
  var entries = [ReminderEntry(date: now, state: state, list: list)]
  if case let .available(snapshot) = state {
    let tasks = TaskWidgetClock.tasks(snapshot, list: list, at: now)
    var changes = Set(
      tasks.compactMap(TaskWidgetClock.dueInstant).map {
        $0.addingTimeInterval(1)
      }.filter { $0 > now && $0 < nextMidnight }
    )
    if let scope = snapshot.accountScope {
      for item in tasks {
        guard let rawRevision = item.updatedAt,
              let revision = Int(exactly: rawRevision),
              let retryDate = WidgetCompletionQueue.retryDate(
                id: item.id, scope: scope, updatedAt: revision
              ) else { continue }
        let retryEntry = retryDate.addingTimeInterval(1)
        if retryEntry > now && retryEntry < nextMidnight {
          changes.insert(retryEntry)
        }
      }
    }
    entries.append(contentsOf: changes.sorted().map {
      ReminderEntry(date: $0, state: state, list: list)
    })
  }
  // Re-evaluate the cached local schedules at midnight, even when the host app
  // remains closed. Overdue Tasks remain visible in their list.
  entries.append(ReminderEntry(date: nextMidnight, state: state, list: list))
  let periodicRefresh = now.addingTimeInterval(15 * 60)
  return Timeline(
    entries: entries,
    policy: .after(min(nextMidnight.addingTimeInterval(1), periodicRefresh))
  )
}

/// The list the user picked in the widget's configuration.
@available(iOSApplicationExtension 17.0, *)
enum TaskWidgetListOption: String, AppEnum {
  case today
  case scheduled
  case all
  case flagged

  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "List")

  // App Intents metadata needs literal values here.
  static let caseDisplayRepresentations: [TaskWidgetListOption: DisplayRepresentation] = [
    .today: DisplayRepresentation(title: "Today", image: .init(systemName: "calendar")),
    .scheduled: DisplayRepresentation(title: "Scheduled", image: .init(systemName: "calendar")),
    .all: DisplayRepresentation(title: "All", image: .init(systemName: "tray.fill")),
    .flagged: DisplayRepresentation(title: "Flagged", image: .init(systemName: "flag.fill"))
  ]

  var list: TaskWidgetList {
    switch self {
    case .today: return .today
    case .scheduled: return .scheduled
    case .all: return .all
    case .flagged: return .flagged
    }
  }
}

@available(iOSApplicationExtension 17.0, *)
struct TaskWidgetConfigurationIntent: WidgetConfigurationIntent {
  static let title: LocalizedStringResource = "Tasks"
  static let description = IntentDescription(
    "Choose which Task list the widget shows."
  )

  /// Apple Reminders opens on the whole list, so "All" is the default here too.
  @Parameter(title: "List", default: .all)
  var list: TaskWidgetListOption

  init() {}

  init(list: TaskWidgetListOption) {
    self.list = list
  }
}

@available(iOSApplicationExtension 17.0, *)
private struct ReminderIntentProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> ReminderEntry {
    ReminderPreview.entry(for: .all)
  }

  func snapshot(
    for configuration: TaskWidgetConfigurationIntent,
    in context: Context
  ) async -> ReminderEntry {
    let now = Date()
    let state = context.isPreview
      ? ReminderPreview.state
      : ReminderSnapshotStore.load(at: now)
    return ReminderEntry(date: now, state: state, list: configuration.list.list)
  }

  func timeline(
    for configuration: TaskWidgetConfigurationIntent,
    in context: Context
  ) async -> Timeline<ReminderEntry> {
    let now = Date()
    return reminderTimeline(
      state: ReminderSnapshotStore.load(at: now),
      list: configuration.list.list,
      now: now
    )
  }
}

/// Placeholder and preview bytes: dated, overdue and undated sample Tasks, so
/// the gallery preview shows every row variant.
private enum ReminderPreview {
  static var state: ReminderSnapshotState {
    let now = Date()
    let today = TaskWidgetClock.localDate(now)
    let yesterday = TaskWidgetClock.localDate(
      TaskWidgetClock.calendar.date(byAdding: .day, value: -1, to: now) ?? now
    )
    let tomorrow = TaskWidgetClock.localDate(
      TaskWidgetClock.calendar.date(byAdding: .day, value: 1, to: now) ?? now
    )
    let samples: [(String, String, String?, String?, Bool)] = [
      ("1", "Review the proposal", today, "09:30", false),
      ("2", "Pick up groceries", yesterday, nil, true),
      ("3", "Call Alex about the launch", today, nil, false),
      ("4", "Book the dentist", nil, nil, false),
      ("5", "Send the quarterly report", tomorrow, "16:00", true),
      ("6", "Water the plants", nil, nil, false)
    ]
    let tasks = samples.map { id, title, dueDate, dueTime, flagged in
      ReminderSnapshotItem(
        id: id,
        updatedAt: nil,
        title: title,
        dueDate: dueDate,
        dueTime: dueTime,
        flagged: flagged,
        priority: "none"
      )
    }
    let snapshot = ReminderSnapshot(
      schemaVersion: 3,
      privacyHidden: false,
      accountScope: nil,
      updatedAt: now.timeIntervalSince1970 * 1000,
      generatedForDate: today,
      generatedForTimeZone: TimeZone.autoupdatingCurrent.identifier,
      utcOffsetMinutes: TaskWidgetClock.utcOffsetMinutes(now),
      count: 3,
      appearance: "system",
      accentLight: "#008837",
      accentDark: "#20A65A",
      upcomingCounts: [tomorrow: 1],
      tasks: tasks,
      totalOpen: tasks.count,
      flaggedOpen: 2,
      generatedDayCount: 2
    )
    return .available(snapshot)
  }

  static func entry(for list: TaskWidgetList) -> ReminderEntry {
    ReminderEntry(date: Date(), state: state, list: list)
  }
}

// MARK: - Reminder UI

private struct ReminderWidgetEntryView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var colorScheme

  let entry: ReminderEntry

  private var referenceDate: Date { max(entry.date, Date()) }

  private var snapshot: ReminderSnapshot? {
    if case let .available(snapshot) = entry.state,
       TaskWidgetClock.isFresh(snapshot, at: referenceDate) {
      return snapshot
    }
    return nil
  }

  private var list: TaskWidgetList { entry.list }

  /// Rows that fit below the header without clipping; extra large splits its
  /// rows into two columns.
  private var rowLimit: Int {
    switch family {
    case .systemSmall: return 3
    case .systemMedium: return 3
    case .systemLarge: return 10
    case .systemExtraLarge: return 20
    default: return 3
    }
  }

  private var columnCount: Int { family == .systemExtraLarge ? 2 : 1 }
  private var compact: Bool { family == .systemSmall }

  private var rows: [ReminderSnapshotItem] {
    guard let snapshot else { return [] }
    return Array(
      TaskWidgetClock.tasks(snapshot, list: list, at: referenceDate)
        .prefix(rowLimit)
    )
  }

  private var totalCount: Int {
    guard let snapshot, snapshot.privacyHidden != true else { return 0 }
    return TaskWidgetClock.count(snapshot, list: list, at: referenceDate)
  }

  private var overflow: Int { max(0, totalCount - rows.count) }

  private var accent: Color { list.color }

  private var effectiveColorScheme: ColorScheme {
    switch snapshot?.appearance {
    case "light": return .light
    case "dark": return .dark
    default: return colorScheme
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: compact ? 6 : 8) {
      header
      content
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .legacyWidgetPadding(compact ? 12 : 14)
    .reminderWidgetBackground()
    .widgetURL(WidgetURLs.reminders)
    // The app's own light/dark choice wins over the system's, including for
    // the container background.
    .environment(\.colorScheme, effectiveColorScheme)
  }

  /// The list's colored circle, its name and the exact count, like the smart
  /// list tiles on the app's Tasks screen. The header opens the Tasks screen.
  private var header: some View {
    HStack(spacing: compact ? 6 : 8) {
      Link(destination: WidgetURLs.reminders) {
        HStack(spacing: compact ? 6 : 8) {
          ZStack {
            Circle().fill(accent)
            Image(systemName: list.symbol)
              .font(.system(size: compact ? 11 : 13, weight: .semibold))
              .foregroundStyle(.white)
          }
          .frame(width: compact ? 24 : 28, height: compact ? 24 : 28)
          .widgetAccented()

          Text(list.title)
            .font(.system(compact ? .subheadline : .headline, design: .rounded).weight(.bold))
            .foregroundStyle(accent)
            .widgetAccented()
            .lineLimit(1)
            .minimumScaleFactor(0.8)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Text(list.title))

      Spacer(minLength: 4)

      if snapshot != nil, snapshot?.privacyHidden != true {
        Text("\(totalCount)")
          .font(.system(compact ? .title2 : .title, design: .rounded).weight(.bold))
          .foregroundStyle(.primary)
          .monospacedDigit()
          .lineLimit(1)
          .accessibilityLabel(Text("\(totalCount) tasks"))
      }

      if !compact {
        newTaskButton
        .accessibilityLabel(Text("New task"))
      }
    }
  }

  @ViewBuilder private var newTaskButton: some View {
    let image = Image(systemName: "plus.circle.fill")
      .font(.system(size: 22))
      .foregroundStyle(accent)
      .widgetAccented()
    if #available(iOSApplicationExtension 18.0, *) {
      Button(intent: VeyraNOpenCaptureIntent(target: .task)) { image }
        .buttonStyle(.plain)
    } else {
      Link(destination: WidgetURLs.newReminder) { image }
        .buttonStyle(.plain)
    }
  }

  @ViewBuilder private var content: some View {
    if snapshot?.privacyHidden == true {
      emptyState(symbol: "lock.fill", title: "Locked")
    } else if snapshot == nil {
      emptyState(symbol: "arrow.clockwise", title: "Open VeyraN to load tasks")
    } else if rows.isEmpty {
      emptyState(symbol: "checkmark.circle", title: "No Tasks", tinted: true)
    } else {
      listBody
    }
  }

  private func emptyState(
    symbol: String,
    title: LocalizedStringKey,
    tinted: Bool = false
  ) -> some View {
    VStack(spacing: 6) {
      Image(systemName: symbol)
        .font(.system(size: compact ? 22 : 26))
        .foregroundStyle(tinted ? AnyShapeStyle(accent) : AnyShapeStyle(.tertiary))
        .widgetAccented(tinted)
      Text(title)
        .font(.system(compact ? .footnote : .subheadline))
        .foregroundStyle(.secondary)
    }
    .multilineTextAlignment(.center)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var listBody: some View {
    VStack(alignment: .leading, spacing: 0) {
      if columnCount == 1 {
        rowsView(rows)
      } else {
        let split = (rows.count + 1) / 2
        HStack(alignment: .top, spacing: 18) {
          rowsView(Array(rows.prefix(split)))
          rowsView(Array(rows.dropFirst(split)))
        }
      }
      // Small and medium widgets have no room for a footer; the header count
      // already says how many Tasks the list holds.
      if overflow > 0, family == .systemLarge || family == .systemExtraLarge {
        Text("+\(overflow) more")
          .font(.caption)
          .foregroundStyle(.secondary)
          .padding(.top, 4)
          .padding(.leading, 30)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func rowsView(_ items: [ReminderSnapshotItem]) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(items.enumerated()), id: \.element.id) { index, reminder in
        ReminderRow(
          reminder: reminder,
          accountScope: snapshot?.accountScope,
          referenceDate: referenceDate,
          compact: compact,
          showsDate: !compact,
          drawDivider: index < items.count - 1
        )
      }
    }
    .frame(maxWidth: .infinity, alignment: .topLeading)
  }
}

/// One Task, laid out like a row in Apple Reminders: a gray ring, the title,
/// and its date on the trailing edge. Tapping the ring completes the Task on
/// iOS 27; tapping the row opens it in the app.
private struct ReminderRow: View {
  let reminder: ReminderSnapshotItem
  let accountScope: String?
  let referenceDate: Date
  let compact: Bool
  let showsDate: Bool
  let drawDivider: Bool

  private var isOverdue: Bool {
    TaskWidgetClock.isOverdue(reminder, at: max(referenceDate, Date()))
  }

  private var completionStatus: WidgetCompletionQueue.Status {
    guard let accountScope, let rawRevision = reminder.updatedAt,
          let updatedAt = Int(exactly: rawRevision) else { return .none }
    return WidgetCompletionQueue.status(
      id: reminder.id, scope: accountScope, updatedAt: updatedAt,
      at: referenceDate)
  }

  private var isPending: Bool { completionStatus == .pending }

  private var needsRetry: Bool {
    completionStatus == .retry || completionStatus == .expired
  }

  var body: some View {
    HStack(spacing: compact ? 6 : 8) {
      completionControl
        .accessibilityLabel(Text(isPending ? "Completion pending" :
          needsRetry ? "Retry completion for \(reminder.title)" : "Complete \(reminder.title)"))

      Link(destination: WidgetURLs.reminder(id: reminder.id)) {
        HStack(spacing: 6) {
          Text(reminder.title)
            .font(.system(compact ? .footnote : .subheadline))
            .foregroundStyle(.primary)
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)

          if let status = statusText {
            Text(status)
              .font(.system(compact ? .caption2 : .caption))
              .foregroundStyle(statusIsWarning ? Color(UIColor.systemRed) : Color.secondary)
              .lineLimit(1)
              .layoutPriority(1)
          }

          if reminder.flagged {
            Image(systemName: "flag.fill")
              .font(.system(size: compact ? 10 : 11, weight: .semibold))
              .foregroundStyle(Color(UIColor.systemOrange))
              .accessibilityHidden(true)
          }
        }
        .frame(maxHeight: .infinity)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) {
          if drawDivider {
            Rectangle()
              .fill(Color.secondary.opacity(0.2))
              .frame(height: 0.5)
          }
        }
      }
      .buttonStyle(.plain)
      .accessibilityLabel(accessibilityLabel)
    }
    .frame(height: compact ? 25 : 28)
  }

  @ViewBuilder private var completionControl: some View {
    if #available(iOSApplicationExtension 27.0, *),
       let accountScope, let rawRevision = reminder.updatedAt,
       let updatedAt = Int(exactly: rawRevision) {
      Button(intent: CompleteTaskInAppWidgetIntent(
        id: reminder.id, scope: accountScope, updatedAt: updatedAt)) {
        completionImage
      }
      .buttonStyle(.plain)
      .disabled(isPending)
    } else {
      // Older systems cannot run the completion intent: the ring opens the
      // Task in the app instead of being a dead image.
      Link(destination: WidgetURLs.reminder(id: reminder.id)) {
        completionImage
      }
      .buttonStyle(.plain)
    }
  }

  private var completionImage: some View {
    Image(systemName: isPending ? "clock" : needsRetry ? "arrow.clockwise.circle" : "circle")
      .font(.system(size: compact ? 16 : 19, weight: .light))
      .foregroundStyle(needsRetry ? Color(UIColor.systemRed) : Color.secondary)
      .frame(width: compact ? 18 : 22)
      .contentShape(Rectangle())
  }

  private var statusIsWarning: Bool {
    needsRetry || (isOverdue && !isPending)
  }

  /// Pending and retry states always show; the due date only where there is
  /// room for it. Undated Tasks have no date text at all.
  private var statusText: String? {
    if isPending { return String(localized: "Completion pending") }
    if needsRetry { return String(localized: "Completion not saved · Tap to retry") }
    guard showsDate else { return nil }
    return dueText
  }

  private var dueText: String? {
    guard let dueDate = reminder.dueDate else { return nil }
    let day: String
    if isOverdue && dueDate < TaskWidgetClock.localDate(referenceDate) {
      day = String(localized: "Overdue")
    } else if dueDate == TaskWidgetClock.localDate(referenceDate) {
      day = String(localized: "Today")
    } else if let tomorrow = TaskWidgetClock.calendar.date(byAdding: .day, value: 1, to: referenceDate),
              dueDate == TaskWidgetClock.localDate(tomorrow) {
      day = String(localized: "Tomorrow")
    } else {
      day = Self.shortDate(dueDate) ?? dueDate
    }
    guard let time = reminder.dueTime else { return day }
    return "\(day) · \(time)"
  }

  private static func shortDate(_ value: String) -> String? {
    let parts = value.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3,
          let date = TaskWidgetClock.calendar.date(
            from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    else { return nil }
    let formatter = DateFormatter()
    formatter.calendar = TaskWidgetClock.calendar
    formatter.timeZone = TaskWidgetClock.calendar.timeZone
    formatter.setLocalizedDateFormatFromTemplate("d MMM")
    return formatter.string(from: date)
  }

  private var accessibilityLabel: String {
    var parts = [reminder.title]
    if let dueText { parts.append(dueText) }
    if reminder.flagged { parts.append(String(localized: "Flagged")) }
    return parts.joined(separator: ", ")
  }
}

@available(iOSApplicationExtension 17.0, *)
private struct ReminderWidget: Widget {
  let kind = "ReminderWidget"

  var body: some WidgetConfiguration {
    AppIntentConfiguration(
      kind: kind,
      intent: TaskWidgetConfigurationIntent.self,
      provider: ReminderIntentProvider()
    ) { entry in
      ReminderWidgetEntryView(entry: entry)
    }
    .configurationDisplayName("Tasks")
    .description("See your Tasks at a glance and check them off.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
  }
}

@available(iOSApplicationExtension 18.0, *)
private struct NewTaskControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "com.ozel0t.veyran.control.newTask") {
      ControlWidgetButton(action: VeyraNOpenCaptureIntent(target: .task)) {
        Label("New Task", systemImage: "plus.circle")
      }
    }
    .displayName("New Task")
    .description("Open VeyraN to create a Task.")
  }
}

@available(iOSApplicationExtension 18.0, *)
private struct NewNoteControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "com.ozel0t.veyran.control.newNote") {
      ControlWidgetButton(action: VeyraNOpenCaptureIntent(target: .note)) {
        Label("New Note", systemImage: "square.and.pencil")
      }
    }
    .displayName("New Note")
    .description("Open VeyraN to create a Note.")
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

  /// Plain system background, like Apple's own list widgets.
  @ViewBuilder func reminderWidgetBackground() -> some View {
    if #available(iOSApplicationExtension 17.0, *) {
      containerBackground(for: .widget) { Color(UIColor.systemBackground) }
    } else {
      background(Color(UIColor.systemBackground))
    }
  }

  /// iOS 17 adds system content margins; earlier systems need our own.
  @ViewBuilder func legacyWidgetPadding(_ length: CGFloat) -> some View {
    if #available(iOSApplicationExtension 17.0, *) {
      self
    } else {
      padding(length)
    }
  }

  /// Keeps list colors in the accent group in tinted and clear rendering.
  @ViewBuilder func widgetAccented(_ enabled: Bool = true) -> some View {
    if #available(iOSApplicationExtension 16.0, *) {
      widgetAccentable(enabled)
    } else {
      self
    }
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

// MARK: - Live Activities
//
// Both surfaces below are silent and additive: they never make a sound, so they
// cannot duplicate an alarm or a notification. Every countdown / elapsed value
// is rendered by SwiftUI's own timer styles, which the system updates on its own
// -- no JavaScript timer and no app refresh is involved.
//
// AlarmKit hands the widget extension the same `AlarmAttributes` the app
// scheduled the alarm with, so the widget can only render what it is given; Task
// titles never reach it except through the attributes the app chose to send.
//
// The alarm and overdue surfaces are iOS-only: on Mac Catalyst the shared types
// they are built from do not exist (see TaskAlarmSurface.swift), and Mac has no
// Live Activities to render them in.

#if canImport(AlarmKit) && !targetEnvironment(macCatalyst)
@available(iOSApplicationExtension 26.0, *)
private struct TaskAlarmLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: AlarmAttributes<TaskAlarmMetadata>.self) { context in
      alarmLockScreenView(context)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          alarmTitle(context)
        }
        DynamicIslandExpandedRegion(.trailing) {
          alarmTimer(context)
        }
        DynamicIslandExpandedRegion(.bottom) {
          HStack {
            alarmStatus(context)
            Spacer(minLength: 0)
            alarmControls(context)
          }
        }
      } compactLeading: {
        Image(systemName: "alarm.fill")
          .foregroundStyle(context.attributes.tintColor)
      } compactTrailing: {
        alarmTimer(context, compact: true)
      } minimal: {
        Image(systemName: "alarm.fill")
          .foregroundStyle(context.attributes.tintColor)
      }
      .keylineTint(context.attributes.tintColor)
    }
  }

  private func alarmTitle(
    _ context: ActivityViewContext<AlarmAttributes<TaskAlarmMetadata>>
  ) -> some View {
    Text(alarmTitleResource(context))
      .font(.headline)
      .lineLimit(1)
  }

  /// The title the app supplied for whichever presentation is on screen.
  private func alarmTitleResource(
    _ context: ActivityViewContext<AlarmAttributes<TaskAlarmMetadata>>
  ) -> LocalizedStringResource {
    switch context.state.mode {
    case .countdown:
      return context.attributes.presentation.countdown?.title
        ?? context.attributes.presentation.alert.title
    case .paused:
      return context.attributes.presentation.paused?.title
        ?? context.attributes.presentation.alert.title
    default:
      return context.attributes.presentation.alert.title
    }
  }

  private func alarmStatus(
    _ context: ActivityViewContext<AlarmAttributes<TaskAlarmMetadata>>
  ) -> some View {
    switch context.state.mode {
    case .countdown:
      return Text("Snoozed")
    case .paused:
      return Text("Paused")
    default:
      return Text("Alarm")
    }
  }

  @ViewBuilder private func alarmTimer(
    _ context: ActivityViewContext<AlarmAttributes<TaskAlarmMetadata>>,
    compact: Bool = false
  ) -> some View {
    switch context.state.mode {
    case .countdown(let countdown):
      // System-rendered countdown to the next alert; no JavaScript timer.
      Text(timerInterval: Date.now ... countdown.fireDate, countsDown: true)
        .monospacedDigit()
        .foregroundStyle(context.attributes.tintColor)
        .font(compact ? .footnote : .title3)
    case .paused(let paused):
      // AlarmKit exposes paused durations as `TimeInterval` (seconds), so the
      // frozen remainder is wrapped back into a `Duration` before handing it to
      // the system's time format style. Paused time does not advance, so this
      // stays accurate without any JavaScript timer or app refresh.
      let remaining = max(0, paused.totalCountdownDuration - paused.previouslyElapsedDuration)
      Text(Duration.seconds(remaining).formatted(.time(pattern: .minuteSecond)))
        .monospacedDigit()
        .foregroundStyle(context.attributes.tintColor)
        .font(compact ? .footnote : .title3)
    default:
      EmptyView()
    }
  }

  @ViewBuilder private func alarmControls(
    _ context: ActivityViewContext<AlarmAttributes<TaskAlarmMetadata>>
  ) -> some View {
    HStack(spacing: 6) {
      switch context.state.mode {
      case .countdown:
        Button(intent: TaskAlarmPauseIntent(alarmID: context.state.alarmID.uuidString)) {
          Label("Pause", systemImage: "pause.fill")
        }
      case .paused:
        Button(intent: TaskAlarmResumeIntent(alarmID: context.state.alarmID.uuidString)) {
          Label("Resume", systemImage: "play.fill")
        }
      default:
        EmptyView()
      }
      // Stop only silences the alert; the Task itself stays incomplete until it
      // is completed through the ordinary Task action.
      Button(intent: TaskAlarmStopIntent(alarmID: context.state.alarmID.uuidString)) {
        Label("Stop", systemImage: "stop.fill")
      }
    }
    .font(.caption)
    .buttonStyle(.bordered)
    .tint(.red)
  }

  private func alarmLockScreenView(
    _ context: ActivityViewContext<AlarmAttributes<TaskAlarmMetadata>>
  ) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        alarmTitle(context)
        Spacer(minLength: 8)
        alarmStatus(context)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      HStack {
        alarmTimer(context)
        Spacer(minLength: 8)
        alarmControls(context)
      }
    }
    .padding(14)
  }
}
#endif

#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
@available(iOSApplicationExtension 16.2, *)
private struct OverdueTaskLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: OverdueTaskActivityAttributes.self) { context in
      overdueLockScreenView(context)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          overdueTitle(context)
        }
        DynamicIslandExpandedRegion(.trailing) {
          overdueElapsed(context, compact: false)
        }
        DynamicIslandExpandedRegion(.bottom) {
          Text("Overdue")
            .font(.caption)
            .foregroundStyle(.red)
        }
      } compactLeading: {
        Image(systemName: "exclamationmark.circle.fill")
          .foregroundStyle(.red)
      } compactTrailing: {
        overdueElapsed(context, compact: true)
      } minimal: {
        overdueElapsed(context, compact: true)
      }
      .keylineTint(.red)
    }
  }

  private func overdueTitle(
    _ context: ActivityViewContext<OverdueTaskActivityAttributes>
  ) -> some View {
    Text(context.state.title)
      .font(.headline)
      .lineLimit(1)
  }

  /// How long the Task has been overdue, rendered by the system's own timer
  /// style so it keeps counting without the app running.
  private func overdueElapsed(
    _ context: ActivityViewContext<OverdueTaskActivityAttributes>,
    compact: Bool
  ) -> some View {
    Text(timerInterval: context.state.dueDate ... Date.distantFuture,
         countsDown: false)
      .monospacedDigit()
      .foregroundStyle(.red)
      .font(compact ? .footnote : .title3)
  }

  private func overdueLockScreenView(
    _ context: ActivityViewContext<OverdueTaskActivityAttributes>
  ) -> some View {
    HStack(spacing: 10) {
      Image(systemName: "exclamationmark.circle.fill")
        .foregroundStyle(.red)
      VStack(alignment: .leading, spacing: 2) {
        overdueTitle(context)
        Text("Overdue")
          .font(.caption)
          .foregroundStyle(.red)
      }
      Spacer(minLength: 8)
      overdueElapsed(context, compact: false)
    }
    .padding(14)
    // Tapping the surface opens the Task's current List with the Task in view.
    // It never opens the editor, and it never completes anything by itself.
    .widgetURL(WidgetURLs.reminder(id: context.attributes.taskId))
  }
}
#endif

/// The bundle the system reads. The home screen widgets (Quick Note, Tasks) and
/// the Control Center controls are the same on iOS and Mac Catalyst; the Live
/// Activity surfaces are iOS-only, because Mac has no Live Activities and the
/// shared ActivityKit/AlarmKit types they are built from are unavailable there.
@main
struct NotesWidgetBundle: WidgetBundle {
  var body: some Widget {
    QuickNoteWidget()
    if #available(iOSApplicationExtension 17.0, *) {
      ReminderWidget()
    }
#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
    if #available(iOSApplicationExtension 16.2, *) {
      OverdueTaskLiveActivity()
    }
#endif
#if canImport(AlarmKit) && !targetEnvironment(macCatalyst)
    if #available(iOSApplicationExtension 26.0, *) {
      TaskAlarmLiveActivity()
    }
#endif
    if #available(iOSApplicationExtension 18.0, *) {
      NewTaskControl()
      NewNoteControl()
    }
  }
}

struct NotesWidget_Previews: PreviewProvider {
  static var previews: some View {
    Group {
      ReminderWidgetEntryView(entry: ReminderPreview.entry(for: .all))
        .previewContext(WidgetPreviewContext(family: .systemSmall))
      ReminderWidgetEntryView(entry: ReminderPreview.entry(for: .all))
        .previewContext(WidgetPreviewContext(family: .systemMedium))
      ReminderWidgetEntryView(entry: ReminderPreview.entry(for: .all))
        .previewContext(WidgetPreviewContext(family: .systemLarge))
    }
  }
}
