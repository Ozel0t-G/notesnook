import React
import UIKit

@objc(VeyraNTabBarViewManager)
final class VeyraNTabBarViewManager: RCTViewManager {
  override func view() -> UIView! { VeyraNTabBarNativeView() }
  @objc override class func requiresMainQueueSetup() -> Bool { true }
}

/// A real UIKit tab bar. The existing React Navigation stacks own screen content;
/// this view only reports top-level section selections to them.
@objc(VeyraNTabBarNativeView)
final class VeyraNTabBarNativeView: UIView, UITabBarDelegate {
  private let tabBar = UITabBar()
  private let sections = ["notes", "tasks", "library", "search"]

  @objc var selectedSection: String = "notes" { didSet { updateSelection() } }
  @objc var onSelect: RCTBubblingEventBlock?

  override init(frame: CGRect) {
    super.init(frame: frame)
    tabBar.translatesAutoresizingMaskIntoConstraints = false
    tabBar.delegate = self
    tabBar.items = [
      UITabBarItem(title: NSLocalizedString("Notes", comment: "Notes tab"), image: UIImage(systemName: "note.text"), tag: 0),
      UITabBarItem(title: NSLocalizedString("Tasks", comment: "Tasks tab"), image: UIImage(systemName: "checklist"), tag: 1),
      UITabBarItem(title: NSLocalizedString("Library", comment: "Library tab"), image: UIImage(systemName: "books.vertical"), tag: 2),
      UITabBarItem(title: NSLocalizedString("Search", comment: "Search tab"), image: UIImage(systemName: "magnifyingglass"), tag: 3)
    ]
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

  private func updateSelection() {
    guard let index = sections.firstIndex(of: selectedSection),
          let items = tabBar.items, index < items.count else { return }
    tabBar.selectedItem = items[index]
  }

  func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
    guard sections.indices.contains(item.tag) else { return }
    onSelect?(["section": sections[item.tag]])
  }
}
