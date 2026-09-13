import AppKit
import Observation
import SwiftUI

@MainActor
@Observable
final class DockInstallPresentation {
    let app: InstalledApp
    let shortcut: URL
    let icon: NSImage
    var errorMessage: String?
    var pickedUp = false
    var isPinned = false

    init(app: InstalledApp, shortcut: URL) {
        self.app = app
        self.shortcut = shortcut
        icon = NSWorkspace.shared.icon(forFile: app.url.path)
    }
}

/// One retained panel and visibility lease, restored as soon as the panel closes.
/// The drag exports the actual alias as a file URL.
@MainActor
final class DockInstallWindowController: NSWindowController, NSWindowDelegate {
    static let shared = DockInstallWindowController()
    let visibility = DockVisibilityManager()
    private var presentation: DockInstallPresentation?
    private var pinVerification: Task<Void, Never>?
    private var activeDrag: UUID?
    private var pinPositionsBeforeDrag: [Int]?
    private var placement: Task<Void, Never>?

    private init() { super.init(window: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func recoverVisibility() {
        do { try visibility.recoverIfNeeded() }
        catch { NSLog("Dock visibility recovery: %@", error.localizedDescription) }
    }

    func restoreVisibilityOnQuit() {
        do { try visibility.restoreOnTermination() }
        catch { NSLog("Dock visibility restore: %@", error.localizedDescription) }
    }

    func show(app: InstalledApp, shortcut: URL) {
        if window?.isVisible == true, presentation?.shortcut == shortcut {
            window?.makeKeyAndOrderFront(nil)
            return
        }
        window?.close()
        let screen = NSApp.keyWindow?.screen ?? NSScreen.main ?? NSScreen.screens.first
        let model = DockInstallPresentation(app: app, shortcut: shortcut)
        presentation = model
        let panel = DockInstallPanel(contentRect: NSRect(x: 0, y: 0, width: 480, height: 164), styleMask: [.borderless], backing: .buffered, defer: false)
        panel.title = "Add \(app.name) to Dock"
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        let hosting = NSHostingView(rootView: DockInstallView(model: model, visibility: visibility,
            close: { [weak panel] in panel?.close() },
            beginDrag: { [weak self] id in self?.pickedUpIcon(in: model, dragID: id) },
            endDrag: { [weak self] id, accepted in self?.checkPin(in: model, dragID: id, afterAcceptedDrop: accepted) }))
        hosting.sizingOptions = []
        panel.contentView = hosting
        panel.setFrame(NSRect(x: 0, y: 0, width: 480, height: 164), display: false)
        window = panel
        do { try visibility.beginPresentation() }
        catch { model.errorMessage = "Couldn't reveal the Dock automatically. Move your pointer to the Dock's screen edge to show it." }
        if let screen { position(panel, besideDockOn: screen) }
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let screen { settlePlacement(of: panel, on: screen) }
    }

    private func position(_ panel: NSPanel, besideDockOn screen: NSScreen) {
        // visibleFrame is read afresh: it excludes the current Dock and menu bar.
        let visible = screen.visibleFrame
        let frame = screen.frame
        let gap: CGFloat = 12
        var x = visible.midX - panel.frame.width / 2
        var y = visible.minY + gap
        if visible.minX - frame.minX > 8 {
            x = visible.minX + gap
            y = visible.midY - panel.frame.height / 2
        } else if frame.maxX - visible.maxX > 8 {
            x = visible.maxX - panel.frame.width - gap
            y = visible.midY - panel.frame.height / 2
        }
        x = min(max(x, visible.minX + gap), max(visible.minX + gap, visible.maxX - panel.frame.width - gap))
        y = min(max(y, visible.minY + gap), max(visible.minY + gap, visible.maxY - panel.frame.height - gap))
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    private func settlePlacement(of panel: NSPanel, on screen: NSScreen) {
        placement?.cancel()
        let displayID = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        // Revealing an auto-hidden Dock restarts it asynchronously. Track the
        // newly reserved space briefly, without moving a panel the user picked up.
        placement = Task { [weak self, weak panel] in
            for _ in 0..<20 {
                try? await Task.sleep(for: .milliseconds(100))
                guard !Task.isCancelled, let self, let panel, panel.isVisible else { return }
                let current = NSScreen.screens.first {
                    $0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber == displayID
                } ?? screen
                self.position(panel, besideDockOn: current)
            }
        }
    }

    func windowWillMove(_ notification: Notification) { placement?.cancel() }

    private func pickedUpIcon(in model: DockInstallPresentation, dragID: UUID) {
        guard presentation === model, window?.isVisible == true else { return }
        placement?.cancel()
        pinVerification?.cancel()
        activeDrag = dragID
        pinPositionsBeforeDrag = try? pinPositions(for: model)
        model.pickedUp = true
        do { try visibility.dragBegan() }
        catch { model.errorMessage = error.localizedDescription }
    }

    private func pinPositions(for model: DockInstallPresentation) throws -> [Int] {
        let resolved = try? URL(resolvingAliasFileAt: model.shortcut, options: [.withoutUI, .withoutMounting])
        let paths = Set([model.shortcut, resolved].compactMap { $0?.standardizedFileURL.resolvingSymlinksInPath().path })
        return try DockShortcutManager().pinsSnapshot().enumerated().compactMap { index, url in
            paths.contains(url.standardizedFileURL.resolvingSymlinksInPath().path) ? index : nil
        }
    }

    private func checkPin(in model: DockInstallPresentation, dragID: UUID, afterAcceptedDrop accepted: Bool) {
        guard presentation === model, activeDrag == dragID, window?.isVisible == true else { return }
        pinVerification?.cancel()
        guard accepted, let before = pinPositionsBeforeDrag else { return }
        // Dock can persist the new item shortly after the drag session ends.
        // Require a newly added or moved shortcut, so an already-pinned URL
        // cannot make an unrelated successful Finder drop close this panel.
        pinVerification = Task { [weak self] in
            let deadline = ContinuousClock.now.advanced(by: .seconds(3))
            while true {
                guard !Task.isCancelled, let self, self.presentation === model,
                      self.activeDrag == dragID, self.window?.isVisible == true else { return }
                if let after = try? self.pinPositions(for: model), !after.isEmpty, after != before {
                    model.isPinned = true
                    self.close()
                    return
                }
                guard ContinuousClock.now < deadline else { return }
                try? await Task.sleep(for: .milliseconds(200))
            }
        }
    }

    func windowWillClose(_ notification: Notification) {
        placement?.cancel()
        pinVerification?.cancel()
        activeDrag = nil
        pinPositionsBeforeDrag = nil
        do { try visibility.endPresentation() }
        catch { presentation?.errorMessage = error.localizedDescription }
    }
}

private final class DockInstallPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { close() }
    override func performClose(_ sender: Any?) { close() }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { close() }
        else { super.keyDown(with: event) }
    }
}

private struct DockInstallView: View {
    @Bindable var model: DockInstallPresentation
    let visibility: DockVisibilityManager
    let close: () -> Void
    let beginDrag: (UUID) -> Void
    let endDrag: (UUID, Bool) -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 20) {
            DockIconDragSource(shortcut: model.shortcut, icon: model.icon, name: model.app.name, beginDrag: beginDrag, endDrag: endDrag)
                .frame(width: 96, height: 96)
                .background(.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 20))
                .overlay { RoundedRectangle(cornerRadius: 20).strokeBorder(.secondary.opacity(0.25), style: StrokeStyle(lineWidth: 1, dash: [4, 4])) }
            VStack(alignment: .leading, spacing: 9) {
                Text("Drag into your Dock").font(.system(size: 21, weight: .semibold))
                Text(ElectronLaunchProfile.supports(model.app)
                     ? "Launch \(model.app.name) from this icon to use your extensions."
                     : "Launch \(model.app.name) from this icon in your Dock.")
                    .font(.system(size: 13)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                TimelineView(.periodic(from: .now, by: 1)) { timeline in
                    if let error = visibility.lastError ?? model.errorMessage {
                        Text(error).font(.caption).foregroundStyle(.secondary)
                    } else if visibility.isTemporarilyVisible {
                        if let deadline = visibility.restoreDeadline {
                            Text("Auto-hide restores in \(max(0, Int(ceil(deadline.timeIntervalSince(timeline.date)))))s.")
                                .font(.caption).foregroundStyle(.secondary)
                        } else {
                            Text("Your Dock is temporarily visible.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    } else {
                        Text("Drop it among the apps in your Dock.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 8) {
                    Button("Show in Finder") {
                        NSWorkspace.shared.activateFileViewerSelecting([model.shortcut])
                        close()
                    }
                    .help("In Finder, press Control–Shift–Command–T to add the selected shortcut to the Dock")
                    .accessibilityLabel("Show shortcut in Finder")
                    .accessibilityHint("Then press Control, Shift, Command and T to add it to the Dock.")
                    Text("Then ⌃⇧⌘T").foregroundStyle(.secondary).accessibilityHidden(true)
                }
                .font(.caption)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        .padding(24)
        .frame(width: 480, height: 164)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22))
        .overlay { RoundedRectangle(cornerRadius: 22).strokeBorder(.primary.opacity(0.08), lineWidth: 1) }
        .overlay(alignment: .topTrailing) {
            Button(action: close) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 24, height: 24)
                    .background(.primary.opacity(0.06), in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
            .help("Close")
            .padding(10)
        }
        .ignoresSafeArea()
    }
}

private struct DockIconDragSource: NSViewRepresentable {
    let shortcut: URL
    let icon: NSImage
    let name: String
    let beginDrag: (UUID) -> Void
    let endDrag: (UUID, Bool) -> Void

    func makeNSView(context: Context) -> DockIconDragView {
        let view = DockIconDragView()
        updateNSView(view, context: context)
        return view
    }
    func updateNSView(_ view: DockIconDragView, context: Context) {
        view.shortcut = shortcut
        view.icon = icon
        view.beginDrag = beginDrag
        view.endDrag = endDrag
        view.setAccessibilityLabel("Drag \(name) into your Dock")
        view.setAccessibilityRole(.image)
        view.setAccessibilityElement(true)
        view.setAccessibilityHelp("Use Show in Finder, then Control–Shift–Command–T to add the selected shortcut without dragging.")
        view.needsDisplay = true
    }
}

private final class DockIconDragView: NSView, NSDraggingSource {
    var shortcut: URL?
    var icon: NSImage?
    var beginDrag: ((UUID) -> Void)?
    var endDrag: ((UUID, Bool) -> Void)?
    private var dragID: UUID?
    private var mouseOrigin: NSPoint?
    private var dragging = false
    override var mouseDownCanMoveWindow: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        icon?.draw(in: bounds.insetBy(dx: 12, dy: 12), from: .zero, operation: .sourceOver, fraction: 1)
    }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    override func mouseDown(with event: NSEvent) { mouseOrigin = convert(event.locationInWindow, from: nil) }
    override func mouseUp(with event: NSEvent) { mouseOrigin = nil }
    override func mouseDragged(with event: NSEvent) {
        guard !dragging, let origin = mouseOrigin, let shortcut, let icon else { return }
        let point = convert(event.locationInWindow, from: nil)
        guard hypot(point.x - origin.x, point.y - origin.y) >= 3 else { return }
        dragging = true
        dragID = UUID()
        let item = NSDraggingItem(pasteboardWriter: shortcut as NSURL)
        item.setDraggingFrame(bounds.insetBy(dx: 12, dy: 12), contents: icon)
        let session = beginDraggingSession(with: [item], event: event, source: self)
        session.animatesToStartingPositionsOnCancelOrFail = true
    }
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { [.copy, .link, .generic] }
    func draggingSession(_ session: NSDraggingSession, willBeginAt screenPoint: NSPoint) {
        if let dragID { beginDrag?(dragID) }
    }
    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        dragging = false
        mouseOrigin = nil
        if let dragID { endDrag?(dragID, !operation.isEmpty) }
        dragID = nil
    }
}

@MainActor
final class ExtensionsApplicationDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        DockInstallWindowController.shared.recoverVisibility()
        ApplicationServices.shared.start()
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification: Notification) { DockInstallWindowController.shared.restoreVisibilityOnQuit() }
}
