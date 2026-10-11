import React
import UIKit

@objc(VeyraNTabBarViewManager)
final class VeyraNTabBarViewManager: RCTViewManager {
  override func view() -> UIView! { VeyraNTabBarNativeView() }
  @objc override class func requiresMainQueueSetup() -> Bool { true }
}

/// A real UIKit tab bar. The existing React Navigation stacks own screen content;
/// this view only reports top-level section selections to them.
///
/// The trailing "New Note" item is an *action*, not a section: selecting it emits
/// `compose` and immediately restores the previously selected real tab, so the
/// user returns to the section they were in once the editor is dismissed.
@objc(VeyraNTabBarNativeView)
final class VeyraNTabBarNativeView: UIView, UITabBarDelegate {
  private let tabBar = UITabBar()
  /// Index-aligned with `tabBar.items`. `compose` is an action, not a section.
  /// The third item opens Settings; it is an action too (the bar highlights
  /// Settings while the sheet is up, and the section underneath is restored on
  /// dismissal), so it is not a persistent section either.
  private let sections = ["library", "tasks", "settings", "compose"]
  private static let composeSection = "compose"

  @objc var selectedSection: String = "library" { didSet { updateSelection() } }
  @objc var onSelect: RCTBubblingEventBlock?
  @objc var itemTitles: NSDictionary = [:] { didSet { updateTitles() } }
  /// The app's single accent (petrol) for the selected tab.
  @objc var tint: UIColor? { didSet { tabBar.tintColor = tint } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    tabBar.translatesAutoresizingMaskIntoConstraints = false
    tabBar.delegate = self

    let libraryItem = UITabBarItem(
      title: NSLocalizedString("Library", comment: "Library tab"),
      image: UIImage(systemName: "books.vertical"),
      tag: 0
    )
    let tasksItem = UITabBarItem(
      title: NSLocalizedString("Tasks", comment: "Tasks tab"),
      image: UIImage(systemName: "checklist"),
      tag: 1
    )
    let settingsItem = UITabBarItem(
      title: NSLocalizedString("Settings", comment: "Settings tab"),
      image: UIImage(systemName: "gearshape"),
      tag: 2
    )
    libraryItem.accessibilityIdentifier = "veyran-tab-library"
    tasksItem.accessibilityIdentifier = "veyran-tab-tasks"
    settingsItem.accessibilityIdentifier = "veyran-tab-settings"

    // Tabs are places, not actions: "New Note" lives in the toolbar
    // (square.and.pencil) like in Notes.
    tabBar.items = [libraryItem, tasksItem, settingsItem]
    addSubview(tabBar)
    NSLayoutConstraint.activate([
      tabBar.leadingAnchor.constraint(equalTo: leadingAnchor),
      tabBar.trailingAnchor.constraint(equalTo: trailingAnchor),
      tabBar.topAnchor.constraint(equalTo: topAnchor),
      tabBar.bottomAnchor.constraint(equalTo: bottomAnchor)
    ])
    updateSelection()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private func updateTitles() {
    guard let items = tabBar.items else { return }
    for (index, key) in sections.enumerated() where index < items.count {
      guard let title = itemTitles[key] as? String else { continue }
      items[index].title = title
      items[index].accessibilityLabel = title
    }
  }

  private func updateSelection() {
    guard let index = sections.firstIndex(of: selectedSection),
          index != sections.firstIndex(of: Self.composeSection),
          let items = tabBar.items, index < items.count else { return }
    tabBar.selectedItem = items[index]
  }

  func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
    guard sections.indices.contains(item.tag) else { return }
    let section = sections[item.tag]
    if section == Self.composeSection {
      // Never leave the action item selected: restore the real tab first so the
      // bar already shows the correct section while the editor animates in.
      updateSelection()
      // On iPad's floating tab presentation UIKit can apply its own selection
      // after this delegate call. Restore once more on the next main turn.
      DispatchQueue.main.async { [weak self] in self?.updateSelection() }
    }
    onSelect?(["section": section])
  }
}
