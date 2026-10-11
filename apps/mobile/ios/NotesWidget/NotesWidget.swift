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
  // "veyran" is this app's own scheme. The old "ShareMedia" scheme is shared
  // with the original Notesnook app, so iOS may route it to the wrong app.
  static let quickNote = URL(string: "veyran://quick-add")!
  static let reminders = URL(string: "veyran://tasks")!
  static let newReminder = URL(string: "veyran://task/new")!

  /// The general "open this Task" URL every card tap uses. It carries the same
  /// occurrence identity the card shows (account scope, revision, occurrence
  /// key and series) plus an explicit `action=open`, so the app validates all of
  /// it before it routes and can refuse a link produced for another account or
  /// for an occurrence that has since moved on. The identity params are
  /// optional, so the plain home-widget row keeps working.
  static func reminder(id: String, scope: String? = nil, updatedAt: Int? = nil,
                       occurrenceKey: String? = nil, seriesId: String? = nil,
                       action: String = "open") -> URL {
    var components = URLComponents()
    components.scheme = "veyran"
    components.host = "task"
    components.path = "/\(id)"
    var items = [URLQueryItem(name: "action", value: action)]
    if let scope { items.append(URLQueryItem(name: "scope", value: scope)) }
    if let updatedAt, updatedAt > 0 {
      items.append(URLQueryItem(name: "updatedAt", value: String(updatedAt)))
    }
    if let occurrenceKey {
      items.append(URLQueryItem(name: "occurrenceKey", value: occurrenceKey))
    }
    if let seriesId { items.append(URLQueryItem(name: "seriesId", value: seriesId)) }
    components.queryItems = items
    return components.url ?? reminders
  }

  /// The one explicit way to open a Task's schedule for editing. It carries the
  /// same occurrence identity the card shows (account scope, revision,
  /// occurrence key and series), so the app can validate all of it before it
  /// opens the picker -- and can refuse a link produced for another account or
  /// for an occurrence that has since moved on.
  static func reschedule(id: String, scope: String?, updatedAt: Int?,
                         occurrenceKey: String?, seriesId: String?) -> URL {
    // The same own-scheme builder as the general open link, carrying the
    // explicit `action=reschedule`; the shared ShareMedia scheme must never be
    // emitted again, because iOS may hand it to the upstream Notesnook app.
    reminder(id: id, scope: scope, updatedAt: updatedAt,
             occurrenceKey: occurrenceKey, seriesId: seriesId,
             action: "reschedule")
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
    // The native glyph leads at the top-left, the title sits at the bottom-left
    // like the Quick Note mockup: a small, quiet card rather than a centered
    // banner.
    VStack(alignment: .leading, spacing: 8) {
      Image(systemName: "square.and.pencil")
        .font(.system(size: 30, weight: .regular))
        .widgetAccented()
      Spacer(minLength: 0)
      Text("New Note")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(.primary)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .reminderWidgetBackground()
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

/// Presentation of the four smart lists the Tasks screen shows. The colors
/// mirror `SMART_LISTS` in `app/screens/tasks/index.tsx`.
private extension TaskWidgetList {
  var title: LocalizedStringKey {
    switch self {
    case .today: return "Today"
    case .scheduled: return "Scheduled"
    case .all: return "All"
    case .flagged: return "Flagged"
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

/// The snapshot now, one entry per due time, midnight, and a 15 minute refresh.
private func reminderTimeline(
  state: ReminderSnapshotState,
  list: TaskWidgetList,
  now: Date
) -> Timeline<ReminderEntry> {
  let nextMidnight = TaskWidgetClock.nextMidnight(after: now)
  var entries = [ReminderEntry(date: now, state: state, list: list)]
  if case let .available(snapshot) = state {
    let tasks = TaskWidgetClock.tasks(snapshot, list: list, at: now)
    let changes = Set(
      tasks.compactMap(TaskWidgetClock.dueInstant).map {
        $0.addingTimeInterval(1)
      }.filter { $0 > now && $0 < nextMidnight }
    )
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

  /// The list the person picked. `default: .all` is the neutral starting point:
  /// a person whose only Task is undated lives in All, whereas a fresh Today
  /// widget would open empty. The configuration UI still offers no "None"
  /// choice, and the intent type name and this parameter's identity are
  /// unchanged, so an existing widget the person set to "Today", "Scheduled",
  /// "All" or "Flagged" keeps its stored choice.
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
    // The gallery leads with the restored default: an All card, so the preview
    // is never an empty Today for someone whose only Task is undated.
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
      // The app's shipped default accent (the palette's fresh mint), so the
      // gallery preview matches what a new person actually sees.
      accentLight: "#087C3E",
      accentDark: "#73DFA0",
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

  /// A realistic one-Task snapshot: the single real Task many people start
  /// with, undated exactly like the user's screenshot — no due date and no due
  /// time are invented for it. It is a separate sample so the gallery previews
  /// above keep their six rows.
  static var sparseState: ReminderSnapshotState {
    let now = Date()
    let today = TaskWidgetClock.localDate(now)
    let tasks = [
      ReminderSnapshotItem(
        id: "1",
        updatedAt: nil,
        title: "Sarajevo travel planning",
        dueDate: nil,
        dueTime: nil,
        flagged: false,
        priority: "none"
      )
    ]
    let snapshot = ReminderSnapshot(
      schemaVersion: 3,
      privacyHidden: false,
      accountScope: nil,
      updatedAt: now.timeIntervalSince1970 * 1000,
      generatedForDate: today,
      generatedForTimeZone: TimeZone.autoupdatingCurrent.identifier,
      utcOffsetMinutes: TaskWidgetClock.utcOffsetMinutes(now),
      count: 1,
      appearance: "system",
      accentLight: "#087C3E",
      accentDark: "#73DFA0",
      upcomingCounts: [:],
      tasks: tasks,
      totalOpen: 1,
      flaggedOpen: 0,
      generatedDayCount: 1
    )
    return .available(snapshot)
  }

  static func sparseEntry(for list: TaskWidgetList) -> ReminderEntry {
    ReminderEntry(date: Date(), state: sparseState, list: list)
  }
}

// MARK: - Shared Task presentation
//
// Overview and Focus render the same snapshot through the same model, so the two
// cards can never disagree about privacy, queued completions or the list count.

/// The presentation both Task widgets share: the freshest readable snapshot, the
/// list the card is configured with, and that list's rows with completions that
/// are still only waiting to sync already removed.
private struct TaskWidgetModel {
  let snapshot: ReminderSnapshot?
  let list: TaskWidgetList
  let referenceDate: Date

  init(entry: ReminderEntry) {
    let reference = max(entry.date, Date())
    self.referenceDate = reference
    self.list = entry.list
    if case let .available(snapshot) = entry.state,
       TaskWidgetClock.isFresh(snapshot, at: reference) {
      self.snapshot = snapshot
    } else {
      self.snapshot = nil
    }
  }

  /// The snapshot is readable, but App Lock has redacted its titles.
  var isLocked: Bool { snapshot?.privacyHidden == true }

  /// The card's brand accent: the app's own accent from the snapshot, resolved
  /// for the appearance the card is rendering.
  ///
  /// The writer already folded Settings > Themes' palette choice into the two
  /// existing v3 fields, so the widget follows the person's accent without any
  /// schema, App Group or privacy change; in the tinted and accented rendering
  /// modes `widgetAccentable` still lets the system own the final color. With no
  /// readable snapshot (never written, or unreadable) the list's own system
  /// color is the fallback, so a card is never colorless.
  func accent(for scheme: ColorScheme) -> Color {
    guard let snapshot else { return list.color }
    return Color(hex: scheme == .dark ? snapshot.accentDark : snapshot.accentLight)
  }

  /// The rows this list shows, minus queued completions so freed slots refill.
  var visibleTasks: [ReminderSnapshotItem] {
    guard let snapshot, snapshot.privacyHidden != true else { return [] }
    return TaskWidgetClock.tasks(snapshot, list: list, at: referenceDate).filter { item in
      guard let scope = snapshot.accountScope,
            let rawRevision = item.updatedAt,
            let updatedAt = Int(exactly: rawRevision) else { return true }
      return !WidgetCompletionQueue.isQueued(
        id: item.id, scope: scope, updatedAt: updatedAt, at: referenceDate)
    }
  }

  /// The list's exact count, minus completions that only wait to sync.
  var totalCount: Int {
    guard let snapshot, snapshot.privacyHidden != true else { return 0 }
    let queued = TaskWidgetClock.tasks(snapshot, list: list, at: referenceDate).count
      - visibleTasks.count
    return max(0, TaskWidgetClock.count(snapshot, list: list, at: referenceDate) - queued)
  }
}

/// The one "no rows to show" state every Task card reuses: locked, not loaded
/// yet, or genuinely empty.
private struct WidgetEmptyState: View {
  let symbol: String
  let title: LocalizedStringKey
  var compact: Bool = false
  var tinted: Bool = false
  var accent: Color = .accentColor

  var body: some View {
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
}

/// One Task's due copy, shared by the compact Overview row and the Focus card.
private enum TaskDueFormat {
  static func isOverdue(_ reminder: ReminderSnapshotItem, at referenceDate: Date) -> Bool {
    TaskWidgetClock.isOverdue(reminder, at: max(referenceDate, Date()))
  }

  /// "Today · 09:30", "Overdue", "12 Sep", or `nil` for an undated Task.
  static func text(for reminder: ReminderSnapshotItem, at referenceDate: Date) -> String? {
    guard let dueDate = reminder.dueDate else { return nil }
    let day: String
    if isOverdue(reminder, at: referenceDate), dueDate < TaskWidgetClock.localDate(referenceDate) {
      day = String(localized: "Overdue")
    } else if dueDate == TaskWidgetClock.localDate(referenceDate) {
      day = String(localized: "Today")
    } else if let tomorrow = TaskWidgetClock.calendar.date(byAdding: .day, value: 1, to: referenceDate),
              dueDate == TaskWidgetClock.localDate(tomorrow) {
      day = String(localized: "Tomorrow")
    } else {
      day = shortDate(dueDate) ?? dueDate
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
}

/// The ring that completes a Task: the iOS 27 background intent when the system
/// can run it, and the Task's own deep link as the older, still-safe fallback.
private struct TaskCompletionControl: View {
  let reminder: ReminderSnapshotItem
  let accountScope: String?
  let referenceDate: Date
  let compact: Bool
  /// The card's brand accent (the person's Settings > Themes choice). The ring
  /// is one of the card's accent elements, so it follows that choice; a retry
  /// ring stays semantic red because it is reporting a failure, not branding.
  let accent: Color

  private var needsRetry: Bool {
    guard let accountScope, let rawRevision = reminder.updatedAt,
          let updatedAt = Int(exactly: rawRevision) else { return false }
    return WidgetCompletionQueue.status(
      id: reminder.id, scope: accountScope, updatedAt: updatedAt,
      at: referenceDate) == .expired
  }

  /// Whether the ring can run the iOS 27 completion intent. The same availability
  /// and identity test drives both the control and its VoiceOver label, so the two
  /// can never disagree about what the ring does.
  private var canRunCompletionIntent: Bool {
    guard #available(iOSApplicationExtension 27.0, *) else { return false }
    guard accountScope != nil, let rawRevision = reminder.updatedAt else { return false }
    return Int(exactly: rawRevision) != nil
  }

  /// The action the ring actually performs: completing the Task when the intent
  /// can run, and opening it in the app otherwise.
  private var accessibilityLabelKey: LocalizedStringKey {
    if canRunCompletionIntent {
      return needsRetry ? "Retry completion for \(reminder.title)" : "Complete \(reminder.title)"
    }
    return "Open task \(reminder.title)"
  }

  var body: some View {
    Group {
      if #available(iOSApplicationExtension 27.0, *),
         let accountScope, let rawRevision = reminder.updatedAt,
         let updatedAt = Int(exactly: rawRevision) {
        Button(intent: QueueTaskCompletionWidgetIntent(
          id: reminder.id, scope: accountScope, updatedAt: updatedAt)) {
          ring
        }
        .buttonStyle(.plain)
      } else {
        // Older systems cannot run the completion intent: the ring opens the
        // Task in the app instead of being a dead image.
        Link(destination: WidgetURLs.reminder(id: reminder.id)) {
          ring
        }
        .buttonStyle(.plain)
      }
    }
    .accessibilityLabel(Text(accessibilityLabelKey))
  }

  private var ring: some View {
    Image(systemName: needsRetry ? "arrow.clockwise.circle" : "circle")
      .font(.system(size: compact ? 16 : 19, weight: .light))
      .foregroundStyle(needsRetry ? Color(UIColor.systemRed) : accent)
      // The normal ring belongs to the card's accent group, so tinted and
      // accented modes recolor it with everything else the system owns. A retry
      // ring is reporting a failure in semantic red, not branding, so it is
      // deliberately kept out of that group.
      .widgetAccented(!needsRetry)
      .frame(width: compact ? 18 : 22)
      .contentShape(Rectangle())
  }
}

/// A divider-separated stack of Task rows, with the first row of `items` treated
/// as the head of the group.
private struct ReminderRows: View {
  let items: [ReminderSnapshotItem]
  let accountScope: String?
  let referenceDate: Date
  let compact: Bool
  let showsDate: Bool
  let accent: Color
  /// The scanning height of one row. Small compacts its own rows; every roomier
  /// family keeps the default.
  var rowHeight: CGFloat = 28

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(items.enumerated()), id: \.element.id) { index, reminder in
        ReminderRow(
          reminder: reminder,
          accountScope: accountScope,
          referenceDate: referenceDate,
          compact: compact,
          showsDate: showsDate,
          accent: accent,
          drawDivider: index < items.count - 1,
          rowHeight: rowHeight
        )
      }
    }
    .frame(maxWidth: .infinity, alignment: .topLeading)
  }
}

// MARK: - Overview UI

@available(iOSApplicationExtension 16.0, *)
private struct ReminderWidgetEntryView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.widgetRenderingMode) private var renderingMode

  let entry: ReminderEntry

  private let model: TaskWidgetModel

  init(entry: ReminderEntry) {
    self.entry = entry
    self.model = TaskWidgetModel(entry: entry)
  }

  private var list: TaskWidgetList { model.list }

  /// Rows that fit below the header without clipping; extra large splits its
  /// rows into two columns. The budget includes the kicker, the title-size
  /// header, the "+N more" footer and the card's content margins, so large caps
  /// at 8 full-height rows and extra large at 18 (9 per column) -- the old
  /// 10/20 clipped once the "TASKS" kicker was added above the header.
  private var rowLimit: Int {
    switch family {
    case .systemSmall: return 2
    case .systemMedium: return 2
    case .systemLarge: return 8
    case .systemExtraLarge: return 18
    default: return 3
    }
  }

  private var columnCount: Int { family == .systemExtraLarge ? 2 : 1 }
  /// Mac Catalyst renders through these same widget families, so the Mac card
  /// reuses this exact compact, native hierarchy instead of Mac-only chrome.
  private var compact: Bool { family == .systemSmall }
  private var prominentHeader: Bool { family == .systemMedium }

  /// Medium packs a kicker, a title-size header, two full-height rows and an
  /// overflow footer into the short medium card, so it uses tighter gaps
  /// between those blocks than the roomier families do.
  private var stackSpacing: CGFloat {
    if compact { return 6 }
    return family == .systemMedium ? 5 : 8
  }

  /// The height every row scans at. Small keeps its own compact metric; the
  /// roomier families all use the default. Medium previously ran shorter rows to
  /// squeeze three in, but it now shows two full-height rows instead.
  private var rowHeight: CGFloat {
    compact ? 25 : 28
  }

  private var rows: [ReminderSnapshotItem] {
    Array(model.visibleTasks.prefix(rowLimit))
  }

  private var overflow: Int { max(0, model.totalCount - rows.count) }

  /// Roomier families spell the remainder out: medium shows only two rows, so
  /// the quiet "+N more" keeps the hidden Tasks exact instead of burying them.
  /// Small already states its whole count in the header, so it drops the footer
  /// rather than risk clipping its compact card.
  private var showsOverflow: Bool {
    switch family {
    case .systemMedium, .systemLarge, .systemExtraLarge: return true
    default: return false
    }
  }

  private var accent: Color { model.accent(for: resolvedColorScheme) }

  /// The appearance the card is actually rendered in: the app's own light/dark
  /// choice while the system renders full colour, otherwise the system's.
  private var resolvedColorScheme: ColorScheme { forcedColorScheme ?? colorScheme }

  /// The mockup's rich charcoal card is a full-colour dark surface. In the
  /// tinted, clear and accented modes the system paints the container, so the
  /// card must not force a surface it does not own.
  private var usesCharcoalCard: Bool {
    renderingMode == .fullColor && resolvedColorScheme == .dark
  }

  /// The mirrored light case: the app forced its light appearance while the
  /// system may be dark, so the card paints its own light surface instead of
  /// trusting `UIColor.systemBackground`, which resolves from the system trait.
  private var usesLightCard: Bool {
    renderingMode == .fullColor && resolvedColorScheme == .light
  }

  /// The app's own light/dark choice wins, but only while the system renders the
  /// card in full colour. In the tinted, clear and accented rendering modes the
  /// system owns the appearance, so the card must not force one over it.
  private var forcedColorScheme: ColorScheme? {
    guard renderingMode == .fullColor else { return nil }
    switch model.snapshot?.appearance {
    case "light": return .light
    case "dark": return .dark
    default: return nil
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: stackSpacing) {
      // Every size leads with the same quiet kicker, so the small card keeps
      // the mockup's hierarchy (kicker, list name, count) instead of dropping
      // straight to the title.
      kicker
      header
      content
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .legacyWidgetPadding(compact ? 12 : 14)
    .reminderWidgetBackground(dark: usesCharcoalCard, light: usesLightCard)
    .widgetURL(WidgetURLs.reminders)
    // The app's own light/dark choice wins over the system's, including for
    // the container background.
    .environment(\.colorScheme, resolvedColorScheme)
  }

  /// The quiet "TASKS" label the medium card leads with.
  private var kicker: some View {
    Text("Tasks")
      .font(.system(size: 11, weight: .semibold))
      .tracking(0.8)
      .textCase(.uppercase)
      .foregroundStyle(.secondary)
  }

  /// The list's name over its exact count. The name is plain, high-contrast
  /// primary text rather than a colored badge, so it leads in every rendering
  /// mode; the count is small and secondary, and the new-Task action is one
  /// restrained plus glyph. The name opens the Tasks screen.
  private var header: some View {
    HStack(spacing: compact ? 6 : 8) {
      Link(destination: WidgetURLs.reminders) {
        Text(list.title)
          .font(titleFont)
          .foregroundStyle(.primary)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Text(list.title))

      Spacer(minLength: 4)

      if model.snapshot != nil, !model.isLocked {
        countLabel
      }

      // The mockup's small card is title, count and rows only; the plus lives
      // on the roomier sizes, and small keeps its whole-card link to Tasks as
      // the create affordance.
      if family != .systemSmall {
        newTaskButton
      }
    }
  }

  /// The exact open count, kept compact and subordinate so the list name leads.
  /// The noun agrees with the number, so the one-Task case reads "1 task" rather
  /// than "1 tasks"; both keys are in `Localizable.xcstrings`.
  private var countLabel: some View {
    let key: LocalizedStringKey = model.totalCount == 1
      ? "\(model.totalCount) task"
      : "\(model.totalCount) tasks"
    return Text(key)
      .font(.system(compact ? .caption2 : .caption, weight: .semibold))
      .foregroundStyle(.secondary)
      .monospacedDigit()
      .lineLimit(1)
      .layoutPriority(1)
      .accessibilityLabel(Text(key))
  }

  /// Medium leads with the list name, so it gets a larger, more prominent face.
  private var titleFont: Font {
    if prominentHeader {
      return .system(.title2, design: .rounded).weight(.bold)
    }
    return .system(compact ? .headline : .title3, design: .rounded).weight(.bold)
  }

  /// A simple accent plus: the system owns its color in tinted and clear modes,
  /// and its frame gives it a comfortable tap target. Medium, large and extra
  /// large carry it; small omits it so the title and count keep the mockup's
  /// uncluttered header, and taps anywhere on the small card still open Tasks.
  @ViewBuilder private var newTaskButton: some View {
    Link(destination: WidgetURLs.newReminder) {
      Image(systemName: "plus")
        .font(.system(size: compact ? 15 : 16, weight: .semibold))
        .foregroundStyle(accent)
        .widgetAccented()
        .frame(width: compact ? 22 : 28, height: compact ? 22 : 28)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(Text("New task"))
  }

  /// A single row on a card that could hold several reads as an accident when
  /// it sits above a tall blank lower half. One real Task is centered in the
  /// leftover space so the sparse state looks deliberate; denser lists, small,
  /// and the two-column extra large card keep their top-aligned scanning.
  private var centersSingleRow: Bool {
    switch family {
    case .systemMedium, .systemLarge: return rows.count == 1 && overflow == 0
    default: return false
    }
  }

  @ViewBuilder private var content: some View {
    if model.isLocked {
      WidgetEmptyState(symbol: "lock.fill", title: "Locked", compact: compact)
    } else if model.snapshot == nil {
      WidgetEmptyState(
        symbol: "arrow.clockwise", title: "Open VeyraN to load tasks", compact: compact)
    } else if rows.isEmpty {
      WidgetEmptyState(
        symbol: "checkmark.circle", title: "No Tasks",
        compact: compact, tinted: true, accent: accent)
    } else {
      listBody
        .frame(
          maxWidth: .infinity, maxHeight: .infinity,
          alignment: centersSingleRow ? .center : .topLeading)
    }
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
      if overflow > 0, showsOverflow {
        Text("+\(overflow) more")
          .font(.caption)
          .foregroundStyle(.secondary)
          .padding(.top, 4)
          .padding(.leading, compact ? 0 : 30)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func rowsView(_ items: [ReminderSnapshotItem]) -> some View {
    ReminderRows(
      items: items,
      accountScope: model.snapshot?.accountScope,
      referenceDate: model.referenceDate,
      compact: compact,
      showsDate: !compact,
      accent: accent,
      rowHeight: rowHeight
    )
  }
}

/// One Task row: the ring queues a completion, the row opens the Task.
private struct ReminderRow: View {
  let reminder: ReminderSnapshotItem
  let accountScope: String?
  let referenceDate: Date
  let compact: Bool
  let showsDate: Bool
  let accent: Color
  let drawDivider: Bool
  /// The row's scanning height, chosen per widget family by `ReminderRows`.
  var rowHeight: CGFloat = 28

  private var isOverdue: Bool {
    TaskDueFormat.isOverdue(reminder, at: referenceDate)
  }

  private var completionStatus: WidgetCompletionQueue.Status {
    guard let accountScope, let rawRevision = reminder.updatedAt,
          let updatedAt = Int(exactly: rawRevision) else { return .none }
    return WidgetCompletionQueue.status(
      id: reminder.id, scope: accountScope, updatedAt: updatedAt,
      at: referenceDate)
  }

  private var needsRetry: Bool { completionStatus == .expired }

  var body: some View {
    HStack(spacing: compact ? 6 : 8) {
      TaskCompletionControl(
        reminder: reminder,
        accountScope: accountScope,
        referenceDate: referenceDate,
        compact: compact,
        accent: accent
      )

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
            // A fine hairline rather than a grey rule: 8% of the label color
            // stays legible on the charcoal card and never competes with a row.
            Rectangle()
              .fill(Color.primary.opacity(0.08))
              .frame(height: 0.5)
          }
        }
      }
      .buttonStyle(.plain)
      .accessibilityLabel(accessibilityLabel)
    }
    .frame(height: rowHeight)
  }

  private var statusIsWarning: Bool {
    needsRetry || isOverdue
  }

  /// The retry state always shows; the due date only where there is room.
  private var statusText: String? {
    if needsRetry { return String(localized: "Completion not saved · Tap to retry") }
    guard showsDate else { return nil }
    return dueText
  }

  private var dueText: String? {
    TaskDueFormat.text(for: reminder, at: referenceDate)
  }

  private var accessibilityLabel: String {
    var parts = [reminder.title]
    if let dueText { parts.append(dueText) }
    if reminder.flagged { parts.append(String(localized: "Flagged")) }
    return parts.joined(separator: ", ")
  }
}

// MARK: - Overview
//
// The installed "Tasks" widget. Its kind string stays "ReminderWidget" so every
// home screen that already placed one keeps it; only the gallery name became
// "Overview".
@available(iOSApplicationExtension 17.0, *)
private struct ReminderWidget: Widget {
  let kind = TaskWidgetKinds.overview

  var body: some WidgetConfiguration {
    AppIntentConfiguration(
      kind: kind,
      intent: TaskWidgetConfigurationIntent.self,
      provider: ReminderIntentProvider()
    ) { entry in
      ReminderWidgetEntryView(entry: entry)
    }
    .configurationDisplayName("Overview")
    .description("See your Tasks at a glance and check them off.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
  }
}

// MARK: - Focus

/// Focus leads with one Task, so its list defaults to Today rather than All.
/// Internal like `TaskWidgetConfigurationIntent`: App Intents has to be able to
/// see the configuration type it extracts metadata for.
@available(iOSApplicationExtension 17.0, *)
struct FocusWidgetConfigurationIntent: WidgetConfigurationIntent {
  static let title: LocalizedStringResource = "Focus"
  static let description = IntentDescription(
    "Choose which Task list the widget shows."
  )

  @Parameter(title: "List", default: .today)
  var list: TaskWidgetListOption

  init() {}

  init(list: TaskWidgetListOption) {
    self.list = list
  }
}

@available(iOSApplicationExtension 17.0, *)
private struct FocusIntentProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> ReminderEntry {
    ReminderPreview.entry(for: .today)
  }

  func snapshot(
    for configuration: FocusWidgetConfigurationIntent,
    in context: Context
  ) async -> ReminderEntry {
    let now = Date()
    let state = context.isPreview
      ? ReminderPreview.state
      : ReminderSnapshotStore.load(at: now)
    return ReminderEntry(date: now, state: state, list: configuration.list.list)
  }

  func timeline(
    for configuration: FocusWidgetConfigurationIntent,
    in context: Context
  ) async -> Timeline<ReminderEntry> {
    // The same builder Overview uses: one snapshot, one refresh schedule.
    let now = Date()
    return reminderTimeline(
      state: ReminderSnapshotStore.load(at: now),
      list: configuration.list.list,
      now: now
    )
  }
}

@available(iOSApplicationExtension 16.0, *)
private struct FocusWidgetEntryView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.widgetRenderingMode) private var renderingMode

  let entry: ReminderEntry

  private let model: TaskWidgetModel

  init(entry: ReminderEntry) {
    self.entry = entry
    self.model = TaskWidgetModel(entry: entry)
  }

  private var compact: Bool { family == .systemSmall }
  /// The iPad extra large card has room for a featured left column.
  private var featuredColumn: Bool { family == .systemExtraLarge }
  private var accent: Color { model.accent(for: resolvedColorScheme) }

  /// The appearance the card is actually rendered in: the app's own light/dark
  /// choice while the system renders full colour, otherwise the system's.
  private var resolvedColorScheme: ColorScheme { forcedColorScheme ?? colorScheme }

  /// Focus shares Overview's surface: a rich charcoal card in full-colour dark,
  /// so the two cards read as one design at every size, iPhone through Mac.
  private var usesCharcoalCard: Bool {
    renderingMode == .fullColor && resolvedColorScheme == .dark
  }

  /// The mirrored light case: the app forced its light appearance while the
  /// system may be dark, so the card paints its own light surface instead of
  /// trusting `UIColor.systemBackground`, which resolves from the system trait.
  private var usesLightCard: Bool {
    renderingMode == .fullColor && resolvedColorScheme == .light
  }

  /// Medium must fit the "Next" heading, the featured Task and one collapsed
  /// "After that" line into the short medium card, so it uses tighter gaps than
  /// large and extra large do.
  private var stackSpacing: CGFloat {
    if compact { return 6 }
    return family == .systemMedium ? 5 : 8
  }

  /// The one Task Focus leads with: the list's most urgent row.
  private var nextTask: ReminderSnapshotItem? { model.visibleTasks.first }

  /// The rows after the featured one. It is always `dropFirst`, so the Task
  /// Focus leads with can never appear again below.
  private var followingRows: [ReminderSnapshotItem] {
    let limit: Int
    switch family {
    case .systemSmall: limit = 0
    case .systemMedium: limit = 1
    case .systemLarge: limit = 5
    case .systemExtraLarge: limit = 8
    default: limit = 1
    }
    return Array(model.visibleTasks.dropFirst().prefix(limit))
  }

  /// How many Tasks fit neither the featured row nor the following list. The
  /// featured row counts as shown, so this stays exact even when the snapshot's
  /// list count is larger than its cached rows.
  private var undisplayedCount: Int {
    max(0, model.totalCount - 1 - followingRows.count)
  }

  /// With only the featured Task and nothing behind it, the card should read as
  /// deliberate rather than pinned above a blank half, so the lead Task is
  /// centered. Small and the two-column extra large card keep their own shape.
  private var centersFeaturedTask: Bool {
    switch family {
    case .systemMedium, .systemLarge:
      return followingRows.isEmpty && undisplayedCount == 0
    default:
      return false
    }
  }

  /// The app's own light/dark choice wins, but only while the system renders the
  /// card in full colour. In the tinted, clear and accented rendering modes the
  /// system owns the appearance, so the card must not force one over it.
  private var forcedColorScheme: ColorScheme? {
    guard renderingMode == .fullColor else { return nil }
    switch model.snapshot?.appearance {
    case "light": return .light
    case "dark": return .dark
    default: return nil
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: stackSpacing) {
      heading
      content
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .legacyWidgetPadding(compact ? 12 : 14)
    .reminderWidgetBackground(dark: usesCharcoalCard, light: usesLightCard)
    .widgetURL(WidgetURLs.reminders)
    .environment(\.colorScheme, resolvedColorScheme)
  }

  /// The card's identity: what it leads with. Small keeps the one-word kicker,
  /// while the roomier families lead with the mockup's prominent "Next" heading,
  /// trailed by the quiet count of open Tasks when there is width for it. The
  /// heading sits outside `content` so the sparse state can still center its
  /// single featured Task in the space below.
  @ViewBuilder private var heading: some View {
    if compact {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text("Next")
          .font(.system(size: 11, weight: .bold))
          .tracking(0.8)
          .textCase(.uppercase)
          .foregroundStyle(accent)
          .widgetAccented()
        Spacer(minLength: 4)
        // Small shows only the featured Task, so the exact open count keeps the
        // Tasks hidden behind it from going unmentioned. It uses the same plural
        // keys as the roomier heading, and the whole row stays hidden from
        // VoiceOver exactly as the bare kicker was.
        if model.snapshot != nil, !model.isLocked, model.totalCount > 0 {
          compactCountLabel
        }
      }
      .lineLimit(1)
      .minimumScaleFactor(0.8)
      .accessibilityHidden(true)
    } else {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text("Next")
          .font(.system(.title2, design: .rounded).weight(.bold))
          .foregroundStyle(.primary)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
        Spacer(minLength: 4)
        if model.snapshot != nil, !model.isLocked {
          headingCountLabel
        }
      }
    }
  }

  /// The small card's quiet total: the same exact count the roomier families
  /// show beside "Next", sized to sit on the compact kicker row without making
  /// it taller.
  private var compactCountLabel: some View {
    let key: LocalizedStringKey = model.totalCount == 1
      ? "\(model.totalCount) task"
      : "\(model.totalCount) tasks"
    return Text(key)
      .font(.system(size: 11, weight: .semibold))
      .foregroundStyle(.secondary)
      .monospacedDigit()
      .lineLimit(1)
      .minimumScaleFactor(0.8)
  }

  /// The quiet context beside the medium-and-up heading: the exact open count of
  /// the configured list, spelled with the same plural keys as Overview.
  private var headingCountLabel: some View {
    let key: LocalizedStringKey = model.totalCount == 1
      ? "\(model.totalCount) task"
      : "\(model.totalCount) tasks"
    return Text(key)
      .font(.system(.caption, weight: .semibold))
      .foregroundStyle(.secondary)
      .monospacedDigit()
      .lineLimit(1)
      .layoutPriority(1)
      .accessibilityLabel(Text(key))
  }

  @ViewBuilder private var content: some View {
    if model.isLocked {
      WidgetEmptyState(symbol: "lock.fill", title: "Locked", compact: compact)
    } else if model.snapshot == nil {
      WidgetEmptyState(
        symbol: "arrow.clockwise", title: "Open VeyraN to load tasks", compact: compact)
    } else if let nextTask {
      focusContent(nextTask)
    } else {
      WidgetEmptyState(
        symbol: "checkmark.circle", title: "No Tasks",
        compact: compact, tinted: true, accent: accent)
    }
  }

  @ViewBuilder private func focusContent(_ nextTask: ReminderSnapshotItem) -> some View {
    if featuredColumn {
      // Extra large: the featured Task owns the left column, the remaining list
      // the right one, so neither is a shrunk copy of the other.
      HStack(alignment: .top, spacing: 18) {
        featuredTask(nextTask, prominent: true)
          .frame(maxWidth: .infinity, alignment: .topLeading)
        VStack(alignment: .leading, spacing: 0) {
          if !followingRows.isEmpty {
            afterThatLabel
            followingList
          }
          if undisplayedCount > 0 {
            overflowLabel
          }
          Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
      }
      .frame(maxWidth: .infinity, alignment: .topLeading)
    } else {
      VStack(alignment: .leading, spacing: stackSpacing) {
        featuredTask(nextTask, prominent: false)
        if family == .systemMedium {
          // Medium is too short for a separate "After that" label, a full row
          // and a footer: they collapse into one concise linked line, which also
          // carries the "+N more" cue.
          mediumAfterThatLine
        } else if !compact {
          // Large and extra large have room for the following list and the
          // footer. Small shows only the featured Task: its compact card has no
          // room for a "+N more" footer without clipping.
          if !followingRows.isEmpty {
            afterThatLabel
            followingList
          }
          if undisplayedCount > 0 {
            overflowLabel
          }
        }
      }
      .frame(
        maxWidth: .infinity, maxHeight: .infinity,
        alignment: centersFeaturedTask ? .center : .topLeading)
    }
  }

  /// The quiet divider between the Task Focus leads with and the rest.
  private var afterThatLabel: some View {
    Text("After that")
      .font(.caption)
      .foregroundStyle(.secondary)
      .padding(.top, 2)
      .accessibilityHidden(true)
  }

  /// Medium's one-line replacement for the "After that" label, the following
  /// list and the footer: the next Task's title, its due when it has one, and
  /// any count still hidden, all on a single caption line that opens that Task.
  /// The featured Task keeps its own completion ring above. A Task with no due
  /// date shows no date -- nothing is invented to fill the line.
  @ViewBuilder private var mediumAfterThatLine: some View {
    if let next = followingRows.first {
      Link(destination: WidgetURLs.reminder(id: next.id)) {
        HStack(spacing: 4) {
          // The label and its colon are one Text unit so no HStack spacing
          // opens a gap before the colon; the catalog key stays "After that"
          // and the colon is appended verbatim, so German reads "Danach:".
          Text(String(localized: "After that") + ":")
            .foregroundStyle(.secondary)
          Text(next.title)
            .foregroundStyle(.primary)
            .lineLimit(1)
            .truncationMode(.tail)
          if let due = TaskDueFormat.text(for: next, at: model.referenceDate) {
            Text(due)
              .foregroundStyle(
                TaskDueFormat.isOverdue(next, at: model.referenceDate)
                  ? Color(UIColor.systemRed) : accent)
              .monospacedDigit()
              .layoutPriority(1)
          }
          if undisplayedCount > 0 {
            Text("+\(undisplayedCount) more")
              .foregroundStyle(.secondary)
              .layoutPriority(1)
          }
          Spacer(minLength: 0)
        }
        .font(.system(.caption))
        .lineLimit(1)
        .minimumScaleFactor(0.9)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Text(afterThatAccessibilityLabel(next)))
    } else if undisplayedCount > 0 {
      // No cached next Task to name, but Tasks are still open behind the
      // featured one: keep the exact remainder visible.
      overflowLabel
    }
  }

  /// VoiceOver reads the collapsed line as one phrase: the context, the Task,
  /// its due and any remaining count, without repeating the visible punctuation.
  private func afterThatAccessibilityLabel(_ task: ReminderSnapshotItem) -> String {
    var parts = [String(localized: "After that"), task.title]
    if let due = TaskDueFormat.text(for: task, at: model.referenceDate) {
      parts.append(due)
    }
    if undisplayedCount > 0 {
      parts.append(String(localized: "+\(undisplayedCount) more"))
    }
    return parts.joined(separator: ", ")
  }

  private var followingList: some View {
    ReminderRows(
      items: followingRows,
      accountScope: model.snapshot?.accountScope,
      referenceDate: model.referenceDate,
      compact: compact,
      showsDate: true,
      accent: accent
    )
  }

  /// The understated count of Tasks the following list had no room for.
  private var overflowLabel: some View {
    Text("+\(undisplayedCount) more")
      .font(.caption)
      .foregroundStyle(.secondary)
      .padding(.top, 3)
  }

  /// The dominant card: the Task's title, its due time and its completion ring.
  private func featuredTask(
    _ task: ReminderSnapshotItem,
    prominent: Bool
  ) -> some View {
    HStack(alignment: .top, spacing: prominent ? 12 : 10) {
      TaskCompletionControl(
        reminder: task,
        accountScope: model.snapshot?.accountScope,
        referenceDate: model.referenceDate,
        compact: compact,
        accent: accent
      )

      Link(destination: WidgetURLs.reminder(id: task.id)) {
        VStack(alignment: .leading, spacing: 3) {
          Text(task.title)
            .font(featuredTitleFont(prominent: prominent))
            .foregroundStyle(.primary)
            .lineLimit(prominent ? 3 : 2)
            .truncationMode(.tail)
            .multilineTextAlignment(.leading)

          HStack(spacing: 6) {
            if let due = TaskDueFormat.text(for: task, at: model.referenceDate) {
              Text(due)
                .font(prominent
                  ? .system(.title2, design: .rounded).weight(.bold)
                  : .system(.subheadline, design: .rounded).weight(.semibold))
                .foregroundStyle(dueStyle(for: task))
                .monospacedDigit()
                .widgetAccented()
            }
            if task.flagged {
              Image(systemName: "flag.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Color(UIColor.systemOrange))
                .accessibilityHidden(true)
            }
          }
          .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(featuredAccessibilityLabel(task))
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// Medium and large give the featured Task a headline-size face so the
  /// hierarchy under the "Next" heading is unmistakable; small stays compact.
  private func featuredTitleFont(prominent: Bool) -> Font {
    if prominent || !compact {
      return .system(.title3, design: .rounded).weight(.semibold)
    }
    return .system(.headline, design: .rounded).weight(.semibold)
  }

  private func dueStyle(for task: ReminderSnapshotItem) -> Color {
    TaskDueFormat.isOverdue(task, at: model.referenceDate)
      ? Color(UIColor.systemRed)
      : accent
  }

  private func featuredAccessibilityLabel(_ task: ReminderSnapshotItem) -> String {
    var parts = [task.title]
    if let due = TaskDueFormat.text(for: task, at: model.referenceDate) {
      parts.append(due)
    }
    if task.flagged { parts.append(String(localized: "Flagged")) }
    return parts.joined(separator: ", ")
  }
}

@available(iOSApplicationExtension 17.0, *)
private struct FocusWidget: Widget {
  let kind = TaskWidgetKinds.focus

  var body: some WidgetConfiguration {
    AppIntentConfiguration(
      kind: kind,
      intent: FocusWidgetConfigurationIntent.self,
      provider: FocusIntentProvider()
    ) { entry in
      FocusWidgetEntryView(entry: entry)
    }
    .configurationDisplayName("Focus")
    .description("See the next Task and what comes after it.")
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

private extension View {
  /// The Task card's surface.
  ///
  /// Dark full colour is the mockup's rich, translucent-looking charcoal
  /// (`#182328`) with a barely-there top sheen: a lit edge that lifts the card
  /// off a black Home Screen instead of the flat near-black surface that made
  /// the old Overview card read as dull grey. Light full colour uses an explicit
  /// white card (`light: true`) rather than `systemBackground`, because the app
  /// can force its own light appearance while the system is dark and the
  /// dynamic colour would then resolve dark under the forced text colours. The
  /// system still owns the real card shape and edge, and in the
  /// tinted/clear/accented rendering modes it paints the container itself, so
  /// no fill is applied there and the surface stays system-managed.
  @ViewBuilder func reminderWidgetBackground(
    dark: Bool = false,
    light: Bool = false
  ) -> some View {
    if #available(iOSApplicationExtension 17.0, *) {
      containerBackground(for: .widget) { cardSurface(dark: dark, light: light) }
    } else {
      background(cardSurface(dark: dark, light: light))
    }
  }

  @ViewBuilder func cardSurface(dark: Bool, light: Bool = false) -> some View {
    if dark {
      ZStack {
        Color(hex: "#182328")
        LinearGradient(
          colors: [Color.white.opacity(0.06), Color.white.opacity(0)],
          startPoint: .top,
          endPoint: .center
        )
      }
    } else if light {
      // Matches the bundled VeyraN light appearance's base background.
      Color(hex: "#FFFFFF")
    } else {
      Color(UIColor.systemBackground)
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
        // No completion control on the alarm card. An alarm identity names a
        // presentation, not the occurrence the person means, so completing from
        // here could apply a future pre-armed recurrence to the original
        // occurrence. Completing stays a plain, in-app Task action.
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
    .tint(.blue)
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
  /// One calm accent for the whole card. The surface states a fact -- this Task
  /// is still open and was due then -- and never warns: no red and no running
  /// counter. Its only interactive controls are the direct completion circle
  /// and the Reschedule link.
  private static let accent = Color.blue

  var body: some WidgetConfiguration {
    ActivityConfiguration(for: OverdueTaskActivityAttributes.self) { context in
      overdueLockScreenView(context)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          overdueCompletionControl(context)
        }
        DynamicIslandExpandedRegion(.trailing) {
          overdueDueTime(context)
        }
        DynamicIslandExpandedRegion(.bottom) {
          HStack(spacing: 8) {
            overdueTitle(context)
            Spacer(minLength: 0)
            overdueRescheduleLink(context)
            overdueStaticMark(context)
          }
        }
      } compactLeading: {
        overdueStaticCircle(compact: true)
      } compactTrailing: {
        overdueStaticMark(context)
      } minimal: {
        overdueStaticCircle(compact: true)
      }
      .keylineTint(Self.accent)
      // The general tap opens the Task and carries the full occurrence identity
      // (scope, revision, occurrence and series): a stale or wrong-account link
      // is refused by the app instead of being resolved accountlessly.
      .widgetURL(WidgetURLs.reminder(
        id: context.attributes.taskId,
        scope: context.state.scope,
        updatedAt: context.state.updatedAt,
        occurrenceKey: context.state.occurrenceKey,
        seriesId: context.state.seriesId))
    }
  }

  /// The direct completion control: a native, round, empty circle that completes
  /// this exact occurrence through the app's own approved `TaskAlarmCompleteIntent`
  /// pipeline. It is only offered when the card carries a full occurrence
  /// identity (scope, revision and due) and the system can run the intent
  /// (iOS 17+); otherwise the circle is a plain static mark and the card's
  /// general tap opens the Task to unlock -- never a fake completion.
  @ViewBuilder private func overdueCompletionControl(
    _ context: ActivityViewContext<OverdueTaskActivityAttributes>
  ) -> some View {
    #if canImport(AlarmKit) && !targetEnvironment(macCatalyst)
    if #available(iOS 17.0, *),
       let scope = context.state.scope,
       let updatedAt = context.state.updatedAt, updatedAt > 0 {
      Button(intent: TaskAlarmCompleteIntent(
        id: context.attributes.taskId,
        scope: scope,
        updatedAt: updatedAt,
        due: context.state.dueDate.timeIntervalSince1970)) {
        Self.completionCircle
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Text("Complete Task"))
    } else {
      Self.completionCircle
        .accessibilityHidden(true)
    }
    #else
    Self.completionCircle
      .accessibilityHidden(true)
    #endif
  }

  /// A small, static mark for the compact presentation: the occurrence is open.
  /// It never counts and never shows a pause glyph, so nothing implies a timer
  /// is running.
  private func overdueStaticCircle(compact: Bool = false) -> some View {
    Image(systemName: "circle")
      .font(compact ? .body : .title3)
      .foregroundStyle(Self.accent)
      .widgetAccented()
      .accessibilityHidden(true)
  }

  /// The shared, calm, empty completion circle. Its frame is a full 44pt hit
  /// area so the control is comfortably tappable on the Lock Screen.
  private static var completionCircle: some View {
    Image(systemName: "circle")
      .font(.title3.weight(.regular))
      .foregroundStyle(accent)
      .frame(width: 44, height: 44)
      .contentShape(Rectangle())
      .widgetAccented()
  }

  private func overdueTitle(
    _ context: ActivityViewContext<OverdueTaskActivityAttributes>
  ) -> some View {
    Text(context.state.title)
      .font(.headline)
      .lineLimit(1)
  }

  /// The occurrence's due time, rendered as a plain, static time. It is never a
  /// `timer` style: nothing on this card counts, so nothing implies the app is
  /// still watching the occurrence.
  private func overdueDueTime(
    _ context: ActivityViewContext<OverdueTaskActivityAttributes>
  ) -> some View {
    HStack(spacing: 4) {
      Text("Due")
      Text(context.state.dueDate, style: .time)
    }
    .font(.caption)
    .foregroundStyle(.secondary)
    .monospacedDigit()
  }

  /// An optional tiny static mark: it says the occurrence was explicitly
  /// stopped, and is simply absent for an ordinary overdue card. It carries no
  /// countdown and no pause glyph -- nothing here implies a timer is running.
  @ViewBuilder private func overdueStaticMark(
    _ context: ActivityViewContext<OverdueTaskActivityAttributes>
  ) -> some View {
    if context.state.stopped == true {
      Image(systemName: "checklist")
        .font(.caption2)
        .foregroundStyle(.secondary)
        .accessibilityLabel(Text("Stopped"))
    }
  }

  /// The one explicit action on the card: open this Task's schedule for
  /// editing. It is a scoped link (Task, account scope, revision, occurrence
  /// and series), so the app validates the exact occurrence before it opens the
  /// picker; a general tap on the card stays an ordinary "open the Task".
  @ViewBuilder private func overdueRescheduleLink(
    _ context: ActivityViewContext<OverdueTaskActivityAttributes>
  ) -> some View {
    Link(destination: WidgetURLs.reschedule(
      id: context.attributes.taskId,
      scope: context.state.scope,
      updatedAt: context.state.updatedAt,
      occurrenceKey: context.state.occurrenceKey,
      seriesId: context.state.seriesId)) {
      Label("Reschedule", systemImage: "calendar")
    }
    .font(.caption.weight(.semibold))
    .foregroundStyle(Self.accent)
    .widgetAccented()
  }

  private func overdueLockScreenView(
    _ context: ActivityViewContext<OverdueTaskActivityAttributes>
  ) -> some View {
    HStack(spacing: 10) {
      overdueCompletionControl(context)
      VStack(alignment: .leading, spacing: 2) {
        overdueTitle(context)
        overdueDueTime(context)
      }
      Spacer(minLength: 8)
      overdueRescheduleLink(context)
      overdueStaticMark(context)
    }
    .padding(14)
    // Tapping the surface opens the Task's current List with the Task in view,
    // carrying the full occurrence identity so a stale or wrong-account link is
    // refused. It never opens the editor, and it never completes anything by
    // itself -- completion is the explicit control above.
    .widgetURL(WidgetURLs.reminder(
      id: context.attributes.taskId,
      scope: context.state.scope,
      updatedAt: context.state.updatedAt,
      occurrenceKey: context.state.occurrenceKey,
      seriesId: context.state.seriesId))
  }
}
#endif

/// The bundle the system reads. The home screen widgets (Quick Note, Overview,
/// Focus) and the Control Center controls are the same on iOS and Mac Catalyst;
/// the Live Activity surfaces are iOS-only, because Mac has no Live Activities
/// and the shared ActivityKit/AlarmKit types they are built from are unavailable
/// there.
@main
struct NotesWidgetBundle: WidgetBundle {
  var body: some Widget {
    QuickNoteWidget()
    if #available(iOSApplicationExtension 17.0, *) {
      ReminderWidget()
      FocusWidget()
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
      if #available(iOSApplicationExtension 16.0, *) {
        ReminderWidgetEntryView(entry: ReminderPreview.entry(for: .all))
          .previewContext(WidgetPreviewContext(family: .systemSmall))
        ReminderWidgetEntryView(entry: ReminderPreview.entry(for: .all))
          .previewContext(WidgetPreviewContext(family: .systemMedium))
        ReminderWidgetEntryView(entry: ReminderPreview.entry(for: .all))
          .previewContext(WidgetPreviewContext(family: .systemLarge))
        // An explicit Today pick with several rows, at the mockup's medium size.
        ReminderWidgetEntryView(entry: ReminderPreview.entry(for: .today))
          .previewContext(WidgetPreviewContext(family: .systemMedium))
        // The sparse state: a person with exactly one real, undated Task. The
        // All list is the one that keeps undated Tasks, so it is what shows the
        // single row the user sees rather than an empty Today card.
        ReminderWidgetEntryView(entry: ReminderPreview.sparseEntry(for: .all))
          .previewContext(WidgetPreviewContext(family: .systemMedium))
        FocusWidgetEntryView(entry: ReminderPreview.entry(for: .today))
          .previewContext(WidgetPreviewContext(family: .systemSmall))
        FocusWidgetEntryView(entry: ReminderPreview.entry(for: .today))
          .previewContext(WidgetPreviewContext(family: .systemMedium))
        FocusWidgetEntryView(entry: ReminderPreview.entry(for: .today))
          .previewContext(WidgetPreviewContext(family: .systemLarge))
        // Focus with one real, undated Task: the featured row only, centered.
        FocusWidgetEntryView(entry: ReminderPreview.sparseEntry(for: .all))
          .previewContext(WidgetPreviewContext(family: .systemMedium))
      }
    }
  }
}
