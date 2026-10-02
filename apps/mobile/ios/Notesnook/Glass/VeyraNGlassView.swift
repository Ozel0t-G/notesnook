import React
import UIKit

/// The Mac Catalyst Liquid Glass surface (Part 1 of the Mac glass design).
///
/// A `UIVisualEffectView` fills the view's bounds with the system material.
/// JS mounts this as a background layer (an absolutely filled child of the
/// panel's plain container `View`, see components/mac-glass-view.tsx), so the
/// React content - sidebar rows, the account card - is a sibling drawn on top;
/// `didAddSubview` still keeps the effect at the back should a child ever be
/// mounted directly here.
///
/// The material is pinned to the *app's* appearance through `dark`, not the
/// system's: the app can run light while macOS is dark (and the other way
/// round), and a glass that followed the system would render a light slab under
/// the app's light text.
///
/// On iOS/Catalyst 26+ this is `UIGlassEffect` (Liquid Glass, regular style);
/// on older systems it falls back to `UIBlurEffect(style: .systemThinMaterial)`
/// so the same JS can be used anywhere without an availability check.
@objc(VeyraNGlassViewManager)
final class VeyraNGlassViewManager: RCTViewManager {
  override func view() -> UIView! { VeyraNGlassNativeView() }
  @objc override class func requiresMainQueueSetup() -> Bool { true }
}

@objc(VeyraNGlassNativeView)
final class VeyraNGlassNativeView: RCTView {
  /// The system material, pinned to the view's bounds and kept at the back.
  private let effectView = UIVisualEffectView(effect: nil)

  /// Corner radius in points, used by the "sidebar" and "card" variants.
  @objc var cornerRadius: CGFloat = 0 {
    didSet { applyCornerRadius() }
  }

  /// "sidebar", "card" or "capsule". A capsule derives its radius from its
  /// height, so it ignores `cornerRadius`.
  @objc var variant: String = "card" {
    didSet { applyCornerRadius() }
  }

  /// Enables interactive Liquid Glass behaviour (hover/press response) where
  /// the system supports it.
  @objc var interactive: Bool = false {
    didSet { rebuildEffect() }
  }

  /// Optional tint applied to the glass.
  @objc var tint: UIColor? {
    didSet { rebuildEffect() }
  }

  /// Whether the glass renders the *app's* dark appearance. JS passes the app
  /// theme, which may differ from the system's, so the material is forced to
  /// that appearance instead of following the window/system.
  @objc var dark: Bool = false {
    didSet {
      applyAppearance()
      rebuildEffect()
    }
  }

  /// A dark-mode glass gets a very subtle white tint so the panel reads as
  /// glass (a faint edge highlight) over the dark window instead of a light
  /// slab; a light-mode glass needs none.
  private static let darkTint = UIColor.white.withAlphaComponent(0.04)

  override init(frame: CGRect) {
    super.init(frame: frame)
    // The glass is the only thing this view paints; the transparent backing
    // lets the window background (now opaque on Mac, see SceneDelegate.m) show
    // through the material.
    backgroundColor = .clear
    isOpaque = false
    effectView.isUserInteractionEnabled = false
    addSubview(effectView)
    applyAppearance()
    rebuildEffect()
    applyCornerRadius()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  /// React inserts its children as subviews after `init`; whichever order the
  /// renderer uses, the effect must stay behind them.
  override func didAddSubview(_ subview: UIView) {
    super.didAddSubview(subview)
    if subview !== effectView {
      sendSubviewToBack(effectView)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    effectView.frame = bounds
    // Recalculate the capsule radius after every size change.
    applyCornerRadius()
  }

  /// Builds the system effect. UIGlassEffect is the Liquid Glass API from
  /// iOS/Catalyst 26; the material blur is the fallback for older runtimes.
  private func rebuildEffect() {
    if #available(iOS 26.0, *) {
      let glass = UIGlassEffect(style: .regular)
      glass.isInteractive = interactive
      glass.tintColor = tint ?? (dark ? VeyraNGlassNativeView.darkTint : nil)
      effectView.effect = glass
    } else {
      effectView.effect = UIBlurEffect(style: .systemThinMaterial)
    }
  }

  /// Pins the material to the app's appearance rather than the system's, so a
  /// dark app under a light macOS (and the other way round) keeps readable,
  /// correctly shaded glass.
  private func applyAppearance() {
    effectView.overrideUserInterfaceStyle = dark ? .dark : .light
  }

  /// Applies the continuous corner radius to both the view and the effect so
  /// React children are clipped to the same rounded shape.
  private func applyCornerRadius() {
    let radius: CGFloat
    if variant == "capsule" {
      radius = bounds.height / 2
    } else {
      radius = cornerRadius
    }
    layer.cornerRadius = radius
    layer.cornerCurve = .continuous
    layer.masksToBounds = true
    effectView.layer.cornerRadius = radius
    effectView.layer.cornerCurve = .continuous
    effectView.layer.masksToBounds = true
  }
}
