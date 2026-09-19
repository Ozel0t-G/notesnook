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
}

/// Full-screen PencilKit canvas. Calls `onFinish` exactly once with either a
/// result (Save) or nil (Cancel).
final class HandwritingViewController: UIViewController, PKCanvasViewDelegate {
  private let canvasView = PKCanvasView()
  private let toolPicker = PKToolPicker()
  private let initialDrawing: PKDrawing
  private var hasChanges = false
  private var finished = false
  private let onFinish: (HandwritingResult?) -> Void

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

  init(drawing: PKDrawing, onFinish: @escaping (HandwritingResult?) -> Void) {
    self.initialDrawing = drawing
    self.onFinish = onFinish
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .fullScreen
    isModalInPresentation = true
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  override func viewDidLoad() {
    super.viewDidLoad()
    // The exported PNG is rendered on white for every client, so edit on white
    // regardless of the system appearance (WYSIWYG, also in Dark Mode).
    overrideUserInterfaceStyle = .light
    view.backgroundColor = .white

    navigationItem.leftBarButtonItems = [cancelItem, clearItem]
    navigationItem.rightBarButtonItems = [saveItem, redoItem, undoItem]

    canvasView.translatesAutoresizingMaskIntoConstraints = false
    canvasView.backgroundColor = .white
    canvasView.isOpaque = true
    // `.default` respects the user's "Only Draw with Apple Pencil" setting.
    canvasView.drawingPolicy = .default
    canvasView.drawing = initialDrawing
    canvasView.delegate = self
    canvasView.minimumZoomScale = 1
    canvasView.maximumZoomScale = 4
    canvasView.alwaysBounceVertical = true
    view.addSubview(canvasView)
    NSLayoutConstraint.activate([
      canvasView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      canvasView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      canvasView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      canvasView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
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
    // Give the canvas room to draw below the initial content. An empty PKDrawing
    // reports `CGRect.null` as its bounds (maxY == +inf), which must never reach
    // `contentSize`; it would make the canvas unusable.
    let drawingBounds = canvasView.drawing.bounds
    let contentBottom = drawingBounds.isNull || drawingBounds.isInfinite ? 0 : drawingBounds.maxY
    let minHeight = max(canvasView.bounds.height, contentBottom + 600)
    if minHeight.isFinite, canvasView.contentSize.height < minHeight {
      canvasView.contentSize = CGSize(width: canvasView.bounds.width, height: minHeight)
    }
  }

  // MARK: - PKCanvasViewDelegate

  func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
    hasChanges = true
    updateButtons()
  }

  private func updateButtons() {
    saveItem.isEnabled = !canvasView.drawing.strokes.isEmpty
    clearItem.isEnabled = !canvasView.drawing.strokes.isEmpty
    undoItem.isEnabled = canvasView.undoManager?.canUndo ?? false
    redoItem.isEnabled = canvasView.undoManager?.canRedo ?? false
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
    guard !drawing.strokes.isEmpty, let result = HandwritingViewController.render(drawing) else {
      return
    }
    finish(result)
  }

  private func finish(_ result: HandwritingResult?) {
    guard !finished else { return }
    finished = true
    toolPicker.setVisible(false, forFirstResponder: canvasView)
    dismiss(animated: true) { [onFinish] in onFinish(result) }
  }

  // MARK: - Rendering

  /// Renders the strokes on an opaque white background, cropped to the drawing
  /// bounds plus padding, so the PNG looks identical in every Notesnook client.
  static func render(_ drawing: PKDrawing, scale: CGFloat = 2) -> HandwritingResult? {
    let padding: CGFloat = 24
    let rect = drawing.bounds.insetBy(dx: -padding, dy: -padding).integral
    guard rect.width > 0, rect.height > 0 else { return nil }

    var image: UIImage?
    UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
      let strokes = drawing.image(from: rect, scale: scale)
      let format = UIGraphicsImageRendererFormat()
      format.scale = scale
      format.opaque = true
      image = UIGraphicsImageRenderer(size: rect.size, format: format).image { context in
        UIColor.white.setFill()
        context.fill(CGRect(origin: .zero, size: rect.size))
        strokes.draw(in: CGRect(origin: .zero, size: rect.size))
      }
    }
    guard let png = image?.pngData() else { return nil }
    return HandwritingResult(
      drawing: drawing, pngData: png,
      width: Int(rect.width * scale), height: Int(rect.height * scale))
  }
}
