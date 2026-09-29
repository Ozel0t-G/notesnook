import React
import UIKit

/// Builds a UIMenu from the plain JSON description sent by React Native:
/// `{ id, title, subtitle?, symbol?, checked?, destructive?, disabled?, inline?, children? }`.
/// An item with `children` becomes a submenu; `inline: true` renders it as a
/// separated group inside its parent, which is how iOS draws menu sections.
enum VeyraNMenuBuilder {
  static func menu(
    title: String,
    items: [Any],
    onSelect: @escaping (String) -> Void
  ) -> UIMenu {
    UIMenu(title: title, children: elements(items, onSelect: onSelect))
  }

  static func elements(
    _ items: [Any],
    onSelect: @escaping (String) -> Void
  ) -> [UIMenuElement] {
    items.compactMap { raw in
      guard let item = raw as? [String: Any] else { return nil }
      let title = item["title"] as? String ?? ""
      let image = (item["symbol"] as? String).flatMap { UIImage(systemName: $0) }
      if let children = item["children"] as? [Any] {
        var options: UIMenu.Options = []
        if item["inline"] as? Bool == true { options.insert(.displayInline) }
        if item["destructive"] as? Bool == true { options.insert(.destructive) }
        let submenu = UIMenu(
          title: title,
          image: image,
          options: options,
          children: elements(children, onSelect: onSelect)
        )
        if #available(iOS 16.0, *), let subtitle = item["subtitle"] as? String {
          submenu.subtitle = subtitle
        }
        return submenu
      }
      guard let id = item["id"] as? String else { return nil }
      let action = UIAction(title: title, image: image) { _ in onSelect(id) }
      if item["checked"] as? Bool == true { action.state = .on }
      var attributes: UIMenuElement.Attributes = []
      if item["destructive"] as? Bool == true { attributes.insert(.destructive) }
      if item["disabled"] as? Bool == true { attributes.insert(.disabled) }
      action.attributes = attributes
      if #available(iOS 16.0, *), let subtitle = item["subtitle"] as? String {
        action.subtitle = subtitle
      }
      return action
    }
  }
}

@objc(VeyraNMenuButtonManager)
final class VeyraNMenuButtonManager: RCTViewManager {
  override func view() -> UIView! { VeyraNMenuButtonView() }
  @objc override class func requiresMainQueueSetup() -> Bool { true }
}

/// A transparent UIButton that opens a pull-down menu on tap. React Native draws
/// the visible row or icon underneath; this view is laid over it so the menu is
/// anchored to the control exactly like `Menu` in SwiftUI.
@objc(VeyraNMenuButtonView)
final class VeyraNMenuButtonView: UIView {
  private let button = UIButton(type: .system)

  @objc var menuItems: NSArray = [] { didSet { rebuild() } }
  @objc var menuTitle: NSString = "" { didSet { rebuild() } }
  @objc var accessibilityTitle: NSString = "" {
    didSet { button.accessibilityLabel = accessibilityTitle as String }
  }
  @objc var onSelectItem: RCTBubblingEventBlock?
  /// When set, the items are requested from JS (`onMenuRequest`) each time the
  /// menu opens and shown as soon as `menuItems` arrives.
  @objc var deferred: Bool = false { didSet { rebuild() } }
  @objc var onMenuRequest: RCTBubblingEventBlock?
  private let pending = VeyraNDeferredMenu()

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    button.translatesAutoresizingMaskIntoConstraints = false
    button.showsMenuAsPrimaryAction = true
    button.backgroundColor = .clear
    addSubview(button)
    NSLayoutConstraint.activate([
      button.leadingAnchor.constraint(equalTo: leadingAnchor),
      button.trailingAnchor.constraint(equalTo: trailingAnchor),
      button.topAnchor.constraint(equalTo: topAnchor),
      button.bottomAnchor.constraint(equalTo: bottomAnchor)
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private func rebuild() {
    let select: (String) -> Void = { [weak self] id in
      self?.onSelectItem?(["id": id])
    }
    if deferred {
      pending.deliver(items: menuItems as? [Any] ?? [], onSelect: select)
      button.menu = UIMenu(title: menuTitle as String, children: [
        pending.element(onSelect: select) { [weak self] in
          self?.onMenuRequest?([:])
        }
      ])
      return
    }
    button.menu = VeyraNMenuBuilder.menu(
      title: menuTitle as String,
      items: menuItems as? [Any] ?? [],
      onSelect: select
    )
  }
}

/// Bridges UIDeferredMenuElement to React Native: the menu asks JS for its
/// items when it opens and completes once they are set as a prop.
final class VeyraNDeferredMenu {
  private var completion: (([UIMenuElement]) -> Void)?
  private var items: [Any] = []
  private var onSelect: ((String) -> Void)?

  func element(
    onSelect: @escaping (String) -> Void,
    request: @escaping () -> Void
  ) -> UIMenuElement {
    self.onSelect = onSelect
    return UIDeferredMenuElement.uncached { [weak self] completion in
      guard let self else { return completion([]) }
      self.completion = completion
      request()
      // Items that are already known are shown right away; JS may refine them.
      if !self.items.isEmpty { self.flush() }
    }
  }

  func deliver(items: [Any], onSelect: @escaping (String) -> Void) {
    self.items = items
    self.onSelect = onSelect
    if !items.isEmpty { flush() }
  }

  private func flush() {
    guard let completion else { return }
    self.completion = nil
    let select = onSelect ?? { _ in }
    completion(VeyraNMenuBuilder.elements(items, onSelect: select))
  }
}

@objc(VeyraNContextMenuManager)
final class VeyraNContextMenuManager: RCTViewManager {
  override func view() -> UIView! { VeyraNContextMenuView() }
  @objc override class func requiresMainQueueSetup() -> Bool { true }
}

/// Wraps React Native content in a UIContextMenuInteraction so a long press
/// lifts the row and shows the native context menu.
@objc(VeyraNContextMenuView)
final class VeyraNContextMenuView: UIView, UIContextMenuInteractionDelegate {
  @objc var menuItems: NSArray = [] {
    didSet {
      guard deferred else { return }
      pending.deliver(items: menuItems as? [Any] ?? []) { [weak self] id in
        self?.onSelectItem?(["id": id])
      }
    }
  }
  @objc var menuTitle: NSString = ""
  @objc var previewCornerRadius: CGFloat = 12
  @objc var onSelectItem: RCTBubblingEventBlock?
  @objc var deferred: Bool = false
  @objc var onMenuRequest: RCTBubblingEventBlock?
  @objc var menuEnabled: Bool = true
  private let pending = VeyraNDeferredMenu()

  override init(frame: CGRect) {
    super.init(frame: frame)
    addInteraction(UIContextMenuInteraction(delegate: self))
  }



  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard menuEnabled else { return nil }
    if deferred {
      return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
        guard let self else { return nil }
        let select: (String) -> Void = { [weak self] id in
          self?.onSelectItem?(["id": id])
        }
        return UIMenu(title: self.menuTitle as String, children: [
          self.pending.element(onSelect: select) { [weak self] in
            self?.onMenuRequest?([:])
          }
        ])
      }
    }
    guard menuItems.count > 0 else { return nil }
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      guard let self else { return nil }
      return VeyraNMenuBuilder.menu(
        title: self.menuTitle as String,
        items: self.menuItems as? [Any] ?? []
      ) { [weak self] id in
        self?.onSelectItem?(["id": id])
      }
    }
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    previewForHighlightingMenuWithConfiguration configuration: UIContextMenuConfiguration
  ) -> UITargetedPreview? {
    let parameters = UIPreviewParameters()
    parameters.visiblePath = UIBezierPath(roundedRect: bounds, cornerRadius: previewCornerRadius)
    return UITargetedPreview(view: self, parameters: parameters)
  }
}
