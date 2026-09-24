import React
import UIKit

@objc(TaskSymbolViewManager)
final class TaskSymbolViewManager: RCTViewManager {
  override func view() -> UIView! { TaskSymbolNativeView() }
  @objc static func requiresMainQueueSetup() -> Bool { true }
}

@objc(TaskSymbolNativeView)
final class TaskSymbolNativeView: UIView {
  private let imageView = UIImageView()

  @objc var symbolName: String = "list.bullet" { didSet { updateSymbol() } }
  @objc var symbolColor: UIColor = .systemGreen { didSet { updateSymbol() } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    imageView.translatesAutoresizingMaskIntoConstraints = false
    imageView.contentMode = .scaleAspectFit
    addSubview(imageView)
    NSLayoutConstraint.activate([
      imageView.leadingAnchor.constraint(equalTo: leadingAnchor),
      imageView.trailingAnchor.constraint(equalTo: trailingAnchor),
      imageView.topAnchor.constraint(equalTo: topAnchor),
      imageView.bottomAnchor.constraint(equalTo: bottomAnchor)
    ])
    updateSymbol()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private func updateSymbol() {
    let image = UIImage(systemName: symbolName) ?? UIImage(systemName: "list.bullet")
    imageView.image = image?.withRenderingMode(.alwaysTemplate)
    imageView.tintColor = symbolColor
  }
}
