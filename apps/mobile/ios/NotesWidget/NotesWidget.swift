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
#if canImport(ActivityKit)
import ActivityKit
#endif
#if canImport(AlarmKit)
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
      var dueChanges = Set(snapshot.tasks.compactMap(TaskWidgetClock.dueInstant).map {
        $0.addingTimeInterval(1)
      }.filter { $0 > now && $0 < nextMidnight })
      if let scope = snapshot.accountScope {
        for item in TaskWidgetClock.visibleTasks(snapshot, at: now) {
          guard let rawRevision = item.updatedAt,
                let revision = Int(exactly: rawRevision),
                let retryDate = WidgetCompletionQueue.retryDate(
                  id: item.id, scope: scope, updatedAt: revision
                ) else { continue }
          let retryEntry = retryDate.addingTimeInterval(1)
          if retryEntry > now && retryEntry < nextMidnight {
            dueChanges.insert(retryEntry)
          }
        }
      }
      entries.append(contentsOf: dueChanges.sorted().map {
        ReminderEntry(date: $0, state: state)
      })
    }
    // Re-evaluate the cached local schedules at midnight, even when the host
    // app remains closed. Incomplete overdue Tasks remain visible.
    entries.append(ReminderEntry(date: nextMidnight, state: state))
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
          updatedAt: nil,
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
      accountScope: nil,
      updatedAt: now.timeIntervalSince1970 * 1000,
      generatedForDate: today,
      generatedForTimeZone: TimeZone.autoupdatingCurrent.identifier,
      utcOffsetMinutes: TaskWidgetClock.utcOffsetMinutes(now),
      count: tasks.count,
      appearance: "system",
      accentLight: "#008837",
      accentDark: "#20A65A",
      upcomingCounts: nil,
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

  private var scheduledTasks: [ReminderSnapshotItem] {
    guard let snapshot else { return [] }
    return TaskWidgetClock.visibleTasks(snapshot, at: max(entry.date, Date()))
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
          Text("VeyraN")
            .font(.system(size: family == .systemSmall ? 13 : 15, weight: .semibold))
            .foregroundStyle(.primary)
          Text("Tasks · Today")
            .font(.system(size: family == .systemSmall ? 9 : 10.5))
            .foregroundStyle(.secondary)
        }
        .lineLimit(1)

        Spacer(minLength: 4)

        if let snapshot, snapshot.privacyHidden != true {
          Text("\(TaskWidgetClock.visibleCount(snapshot, at: max(entry.date, Date())))")
            .font(.system(size: family == .systemSmall ? 11 : 12, weight: .semibold))
            .foregroundStyle(.primary)
            .padding(.horizontal, family == .systemSmall ? 8 : 10)
            .frame(height: family == .systemSmall ? 23 : 25)
            .background(accent.opacity(effectiveColorScheme == .dark ? 0.28 : 0.16))
            .clipShape(Capsule())
            .accessibilityLabel(Text("\(TaskWidgetClock.visibleCount(snapshot, at: max(entry.date, Date()))) tasks today"))
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
      } else if scheduledTasks.isEmpty {
        emptyState(title: "No tasks today")
      } else {
        reminderLayout(Array(scheduledTasks.prefix(visibleCount)))
      }
    } else {
      emptyState(title: "Open VeyraN to refresh tasks")
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
          accountScope: snapshot?.accountScope,
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
  let accountScope: String?
  let referenceDate: Date
  let accent: Color
  let compact: Bool
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
    HStack(spacing: compact ? 6 : 9) {
      Group {
        if #available(iOSApplicationExtension 27.0, *),
           let accountScope, let rawRevision = reminder.updatedAt,
           let updatedAt = Int(exactly: rawRevision) {
          Button(intent: CompleteTaskWidgetIntent(
            id: reminder.id, scope: accountScope, updatedAt: updatedAt)) {
            completionImage
          }
          .disabled(isPending)
        }
      }
      .accessibilityLabel(Text(isPending ? "Completion pending" :
        needsRetry ? "Retry completion for \(reminder.title)" : "Complete \(reminder.title)"))

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
        Text(isPending ? String(localized: "Completion pending") :
          needsRetry ? String(localized: "Completion not saved · Tap to retry") : secondaryText)
          .font(.system(size: compact ? 9.5 : 11))
          .foregroundStyle(
            (needsRetry || (isOverdue && !isPending)) ? Color(UIColor.systemRed) : Color.secondary
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

  private var completionImage: some View {
    Image(systemName: isPending ? "clock" : needsRetry ? "arrow.clockwise.circle" : "circle")
      .font(.system(size: compact ? 18 : 21))
      .foregroundStyle(accent)
      .frame(width: compact ? 24 : 30, height: compact ? 28 : 34)
      .contentShape(Rectangle())
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
    .description("See today's tasks and create a task. Complete tasks here on iOS 27.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
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

#if canImport(AlarmKit)
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

@main
struct NotesWidgetBundle: WidgetBundle {
  var body: some Widget {
    QuickNoteWidget()
    ReminderWidget()
    if #available(iOSApplicationExtension 16.2, *) {
      OverdueTaskLiveActivity()
    }
#if canImport(AlarmKit)
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
      ReminderWidgetEntryView(entry: ReminderProvider.previewEntry)
        .previewContext(WidgetPreviewContext(family: .systemSmall))
      ReminderWidgetEntryView(entry: ReminderProvider.previewEntry)
        .previewContext(WidgetPreviewContext(family: .systemMedium))
      ReminderWidgetEntryView(entry: ReminderProvider.previewEntry)
        .previewContext(WidgetPreviewContext(family: .systemLarge))
    }
  }
}
