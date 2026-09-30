/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import PencilKit
import UIKit

struct HandwritingResult {
  let drawing: PKDrawing
  let pngData: Data
  let width: Int
  let height: Int
  /// Metadata to store next to the drawing (background, paper, page width).
  let metadata: HandwritingMetadata
}

/// Full-screen PencilKit canvas. Calls `onFinish` exactly once with either a
/// result (Save) or nil (Cancel).
///
/// Layers, bottom to top: background colour + paper template
/// (`PaperBackgroundView`), then the transparent `PKCanvasView` with the
/// strokes. Only the strokes are part of the PKDrawing.
final class HandwritingViewController: UIViewController, PKCanvasViewDelegate,
  UIColorPickerViewControllerDelegate
{
  private let paperView = PaperBackgroundView()
  private let canvasView = PKCanvasView()
  private let toolPicker = PKToolPicker()
  private let initialDrawing: PKDrawing
  private let initialMetadata: HandwritingMetadata
  private var metadata: HandwritingMetadata
  private var drawingChanged = false
  private var finished = false
  /// Page width in points, fixed at the first layout (see `updateContentSize`).
  private var pageWidth: CGFloat?
  private let onFinish: (HandwritingResult?) -> Void

  private var hasChanges: Bool { drawingChanged || metadata != initialMetadata }

  private lazy var saveItem = UIBarButtonItem(
    title: "Save", style: .done, target: self, action: #selector(saveTapped))
  private lazy var cancelItem = UIBarButtonItem(
    title: "Cancel", style: .plain, target: self, action: #selector(cancelTapped))
  private lazy var undoItem = UIBarButtonItem(
    image: UIImage(systemName: "arrow.uturn.backward"), style: .plain, target: self,
    action: #selector(undoTapped))
  private lazy var redoItem = UIBarButtonItem(
    image: UIImage(systemName: "arrow.uturn.forward"), style: .plain, target: self,
    action: #selector(redoTapped))
  private lazy var clearItem = UIBarButtonItem(
    title: "Clear", style: .plain, target: self, action: #selector(clearTapped))
  private lazy var backgroundItem = UIBarButtonItem(
    image: UIImage(systemName: "paintpalette") ?? UIImage(systemName: "circle.lefthalf.filled"),
    menu: nil)
  private lazy var paperItem = UIBarButtonItem(
    image: UIImage(systemName: "square.grid.2x2"), menu: nil)

  init(
    drawing: PKDrawing, metadata: HandwritingMetadata,
    onFinish: @escaping (HandwritingResult?) -> Void
  ) {
    self.initialDrawing = drawing
    self.initialMetadata = metadata
    self.metadata = metadata
    self.onFinish = onFinish
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .fullScreen
    isModalInPresentation = true
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  override func viewDidLoad() {
    super.viewDidLoad()

    backgroundItem.accessibilityLabel = "Background"
    paperItem.accessibilityLabel = "Paper"
    undoItem.accessibilityLabel = "Undo"
    redoItem.accessibilityLabel = "Redo"
    // Compact bar: [Cancel] [Clear] ........ [Background] [Paper] [Undo] [Redo] [Save]
    navigationItem.leftBarButtonItems = [cancelItem, clearItem]
    navigationItem.rightBarButtonItems = [saveItem, redoItem, undoItem, paperItem, backgroundItem]

    for subview in [paperView, canvasView] {
      subview.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(subview)
      NSLayoutConstraint.activate([
        subview.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
        subview.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        subview.leadingAnchor.constraint(equalTo: view.leadingAnchor),
        subview.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      ])
    }
    // The canvas is transparent: the paper view underneath provides the page.
    canvasView.backgroundColor = .clear
    canvasView.isOpaque = false
    // `.default` respects the user's "Only Draw with Apple Pencil" setting.
    // On Mac (Mac interface idiom) there is no Apple Pencil: `.default` would
    // leave the canvas unable to take any input at all, so the pointer draws.
    #if targetEnvironment(macCatalyst)
      canvasView.drawingPolicy = .anyInput
    #else
      canvasView.drawingPolicy = .default
    #endif
    canvasView.drawing = initialDrawing
    canvasView.delegate = self
    canvasView.minimumZoomScale = 1
    canvasView.maximumZoomScale = 4
    canvasView.alwaysBounceVertical = true
    canvasView.contentInsetAdjustmentBehavior = .never

    applyMetadata()
    updateButtons()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    toolPicker.setVisible(true, forFirstResponder: canvasView)
    toolPicker.addObserver(canvasView)
    canvasView.becomeFirstResponder()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    if pageWidth == nil, canvasView.bounds.width > 0 {
      // A page is at least as wide as the screen it was opened on. A stored
      // wider page (created in landscape, edited in portrait) scrolls sideways.
      pageWidth = max(CGFloat(metadata.canvasWidth ?? 0), canvasView.bounds.width.rounded(.down))
    }
    updateContentSize()
    syncPaper()
  }

  /// Gives the canvas room to draw below the current content and never shrinks.
  /// An empty PKDrawing reports `CGRect.null` as its bounds (maxY == +inf),
  /// which must never reach `contentSize`; it would make the canvas unusable.
  private func updateContentSize() {
    let drawingBounds = canvasView.drawing.bounds
    let contentBottom = drawingBounds.isNull || drawingBounds.isInfinite ? 0 : drawingBounds.maxY
    let height = max(canvasView.bounds.height, contentBottom + 600)
    let width = max(pageWidth ?? 0, canvasView.bounds.width)
    guard height.isFinite, width.isFinite else { return }
    let target = CGSize(width: width, height: max(canvasView.contentSize.height, height))
    if target != canvasView.contentSize { canvasView.contentSize = target }
  }

  private func syncPaper() {
    paperView.contentOffset = canvasView.contentOffset
    paperView.zoomScale = canvasView.zoomScale
  }

  // MARK: - PKCanvasViewDelegate

  func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
    drawingChanged = true
    updateContentSize()
    updateButtons()
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) { syncPaper() }

  func scrollViewDidZoom(_ scrollView: UIScrollView) { syncPaper() }

  private func updateButtons() {
    saveItem.isEnabled = !canvasView.drawing.strokes.isEmpty
    clearItem.isEnabled = !canvasView.drawing.strokes.isEmpty
    undoItem.isEnabled = canvasView.undoManager?.canUndo ?? false
    redoItem.isEnabled = canvasView.undoManager?.canRedo ?? false
  }

  // MARK: - Background and paper

  /// Applies `metadata` to the page and the chrome. The interface style follows
  /// the background so PencilKit shows the ink exactly as the PNG will contain it.
  private func applyMetadata() {
    let style = metadata.inkStyle
    overrideUserInterfaceStyle = style
    navigationController?.overrideUserInterfaceStyle = style
    view.backgroundColor = metadata.backgroundColor
    paperView.metadata = metadata
    backgroundItem.menu = makeBackgroundMenu()
    paperItem.menu = makePaperMenu()
  }

  private func setBackground(_ hex: String) {
    guard hex != metadata.backgroundHex else { return }
    metadata.backgroundHex = hex
    applyMetadata()
  }

  private func makeBackgroundMenu() -> UIMenu {
    let current = metadata.backgroundHex
    let presets = HandwritingMetadata.presetBackgrounds
    let colors = presets.map { preset in
      UIAction(
        title: preset.name, image: HandwritingViewController.swatch(preset.hex),
        state: preset.hex == current ? .on : .off
      ) { [weak self] _ in self?.setBackground(preset.hex) }
    }
    let isCustom = !presets.contains { $0.hex == current }
    let custom = UIAction(
      title: "Custom Color…", image: HandwritingViewController.swatch(current, custom: true),
      state: isCustom ? .on : .off
    ) { [weak self] _ in
      // let the menu finish dismissing before presenting the picker
      DispatchQueue.main.async { self?.presentColorPicker() }
    }
    return UIMenu(
      title: "Background",
      children: [
        UIMenu(title: "", options: .displayInline, children: colors),
        UIMenu(title: "", options: .displayInline, children: [custom]),
      ])
  }

  private func makePaperMenu() -> UIMenu {
    let types = PaperType.allCases.map { type in
      UIAction(title: type.rawValue.capitalized, state: type == metadata.paperType ? .on : .off) {
        [weak self] _ in
        guard let self = self, self.metadata.paperType != type else { return }
        self.metadata.setPaper(type)
        self.applyMetadata()
      }
    }
    let spacings = PaperSpacing.allCases.map { spacing in
      UIAction(
        title: spacing.rawValue.capitalized,
        attributes: metadata.paperType == .blank ? .disabled : [],
        state: spacing == metadata.spacing ? .on : .off
      ) { [weak self] _ in
        guard let self = self else { return }
        self.metadata.setSpacing(spacing)
        self.applyMetadata()
      }
    }
    return UIMenu(
      title: "Paper",
      children: [
        UIMenu(title: "", options: .displayInline, children: types),
        UIMenu(title: "Spacing", options: .displayInline, children: spacings),
      ])
  }

  private static func swatch(_ hex: String, custom: Bool = false) -> UIImage? {
    let size = CGSize(width: 22, height: 22)
    let image = UIGraphicsImageRenderer(size: size).image { _ in
      let rect = CGRect(origin: .zero, size: size).insetBy(dx: 2, dy: 2)
      (UIColor(hex: hex) ?? .white).setFill()
      UIBezierPath(ovalIn: rect).fill()
      UIColor.systemGray.setStroke()
      let outline = UIBezierPath(ovalIn: rect)
      outline.lineWidth = 1
      outline.stroke()
    }
    return image.withRenderingMode(.alwaysOriginal)
  }

  private func presentColorPicker() {
    guard presentedViewController == nil else { return }
    let picker = UIColorPickerViewController()
    picker.selectedColor = metadata.backgroundColor
    picker.supportsAlpha = false
    picker.delegate = self
    picker.modalPresentationStyle = .popover
    picker.popoverPresentationController?.barButtonItem = backgroundItem
    present(picker, animated: true)
  }

  // The system picker reports selections through one of these two delegate
  // methods depending on the OS; both apply the colour (setBackground is idempotent).
  func colorPickerViewController(
    _ viewController: UIColorPickerViewController, didSelect color: UIColor, continuous: Bool
  ) {
    setBackground(HandwritingMetadata.hex(from: color))
  }

  func colorPickerViewControllerDidSelectColor(_ viewController: UIColorPickerViewController) {
    setBackground(HandwritingMetadata.hex(from: viewController.selectedColor))
  }

  func colorPickerViewControllerDidFinish(_ viewController: UIColorPickerViewController) {
    // refresh the "custom" check mark of the menu
    applyMetadata()
  }

  // MARK: - Actions

  @objc private func undoTapped() {
    canvasView.undoManager?.undo()
    updateButtons()
  }

  @objc private func redoTapped() {
    canvasView.undoManager?.redo()
    updateButtons()
  }

  @objc private func clearTapped() {
    canvasView.drawing = PKDrawing()
  }

  @objc private func cancelTapped() {
    guard hasChanges else { return finish(nil) }
    let alert = UIAlertController(
      title: "Discard changes?", message: "Your handwriting changes will be lost.",
      preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "Keep editing", style: .cancel))
    alert.addAction(
      UIAlertAction(title: "Discard", style: .destructive) { [weak self] _ in self?.finish(nil) })
    present(alert, animated: true)
  }

  @objc private func saveTapped() {
    let drawing = canvasView.drawing
    guard !drawing.strokes.isEmpty,
      let output = HandwritingExporter.render(
        drawing, metadata: metadata, pageWidth: pageWidth ?? canvasView.bounds.width)
    else { return }
    finish(
      HandwritingResult(
        drawing: drawing, pngData: output.pngData, width: output.width, height: output.height,
        metadata: output.metadata))
  }

  private func finish(_ result: HandwritingResult?) {
    guard !finished else { return }
    finished = true
    toolPicker.setVisible(false, forFirstResponder: canvasView)
    dismiss(animated: true) { [onFinish] in onFinish(result) }
  }
}
