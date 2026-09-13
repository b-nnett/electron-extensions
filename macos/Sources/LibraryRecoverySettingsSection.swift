import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct LibraryRecoverySettingsSection: View {
    @Bindable var manager: ExtensionManager
    @State private var resultMessage: String?

    private var recovery: LibraryRecovery { LibraryRecovery(storageURL: manager.storageFileURL) }

    var body: some View {
        Section {
            Text("Before changing an existing valid library, its previous state is saved as a last-good backup. Exports include source and enabled preferences.")
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Export Library…", action: exportLibrary).disabled(manager.loadFailed)
                Button("Restore Backup…", action: restoreLibrary)
            }
            Text("Restoring replaces the saved library with all restored extensions disabled. Managed sessions must be stopped first; existing library bytes are preserved separately.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let resultMessage {
                Text(resultMessage).font(.caption).foregroundStyle(.secondary)
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            Text("Extension library")
        }
    }

    private func exportLibrary() {
        let panel = NSSavePanel()
        panel.title = "Export Extension Library"
        panel.nameFieldStringValue = "Extensions Anywhere Library.json"
        panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        do {
            try recovery.export(to: destination)
            resultMessage = "Exported to \(destination.path)"
        } catch { show(error) }
    }

    private func restoreLibrary() {
        let panel = NSOpenPanel()
        panel.title = "Restore Extension Library"
        panel.allowedContentTypes = [.json]
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = manager.storageFileURL.deletingLastPathComponent()
        panel.message = "Choose an exported library or library.last-good.json. All restored extensions will be disabled."
        guard panel.runModal() == .OK, let source = panel.url else { return }
        do {
            let service = recovery
            let plan = try service.prepareRestore(from: source)
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = "Replace your extension library?"
            alert.informativeText = "Restore \(plan.recordCount) extensions from \(plan.sourceName). All restored extensions will be disabled until you enable them. Your current library, including damaged data, will be preserved separately. No apps will open and Dock shortcuts will stay unchanged."
            alert.addButton(withTitle: "Restore Disabled")
            alert.addButton(withTitle: "Cancel").keyEquivalent = "\u{1b}"
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            let restored = try service.restore(plan)
            manager.reload()
            if !manager.loadFailed { manager.errorMessage = nil }
            resultMessage = "Restored \(restored.recordCount) extensions, all disabled."
                + (restored.preservedOriginal.map { " Previous library: \($0.path)" } ?? "")
        } catch { show(error) }
    }

    private func show(_ error: Error) {
        let alert = NSAlert(error: error)
        alert.runModal()
    }
}
