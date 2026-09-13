import AppKit
import SwiftUI

struct UnavailableAppExtensionsView: View {
    let app: UnavailableApp
    @Bindable var manager: ExtensionManager
    var refreshApps: () -> Void
    @State private var sourceRecord: ExtensionRecord?
    @State private var removalRecord: ExtensionRecord?

    private var records: [ExtensionRecord] {
        manager.library.records.filter { $0.appKey == app.appKey }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Extensions").font(.system(size: 25, weight: .semibold))
                    Text("\(records.count) saved")
                        .font(.system(size: 13)).foregroundStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Label("App not installed", systemImage: "app.dashed")
                        .font(.headline)
                    Text("Your extensions are still saved. You can view their source, disable them, or remove them. Install the matching app to enable extensions or launch it.")
                        .foregroundStyle(.secondary)
                    Text(app.appKey).font(.caption.monospaced()).foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    Button("Refresh Apps", action: refreshApps)
                }

                ForEach(records) { record in
                    VStack(alignment: .leading, spacing: 14) {
                        HStack(spacing: 12) {
                            ExtensionGlyph(type: record.sourceType)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(record.name).font(.headline)
                                Text("\(record.sourceLabel) · \(record.fileCount) \(record.fileCount == 1 ? "file" : "files")")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Toggle("Saved as enabled", isOn: Binding(
                                get: { manager.record(record.id)?.isEnabled ?? false },
                                set: { enabled in
                                    guard !enabled else { return }
                                    perform { try manager.disableSavedRecord(record) }
                                }
                            ))
                            .toggleStyle(.switch).controlSize(.small)
                            .disabled(!record.isEnabled || manager.loadFailed)
                            .help(record.isEnabled ? "Disable this saved extension" : "Install the matching app before enabling this extension")
                        }
                        if !record.description.isEmpty {
                            Text(record.description).foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                        HStack {
                            Button("View Source") { sourceRecord = record }
                            Spacer()
                            Button("Remove Extension", role: .destructive) { removalRecord = record }
                                .disabled(manager.loadFailed)
                        }
                    }
                    .padding(18)
                    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
                    .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(.primary.opacity(0.09)) }
                }

                Text("Removing saved extensions here leaves existing Dock shortcuts unchanged.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(28)
            .frame(maxWidth: 1080, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .navigationTitle("")
        .toolbar {
            ToolbarItem(placement: .principal) {
                Label(app.name, systemImage: "app.dashed")
                    .font(.system(size: 13, weight: .semibold)).padding(.horizontal, 10)
            }
            ToolbarItem(placement: .primaryAction) {
                Button {} label: { Text("Open App").padding(.horizontal, 10) }
                    .disabled(true)
                    .help("No matching app is installed")
            }
        }
        .sheet(item: $sourceRecord) { record in SavedExtensionSourceSheet(record: record) }
        .confirmationDialog("Remove \(removalRecord?.name ?? "extension")?", isPresented: Binding(
            get: { removalRecord != nil }, set: { if !$0 { removalRecord = nil } }
        ), titleVisibility: .visible, presenting: removalRecord) { record in
            Button("Remove Extension", role: .destructive) {
                perform { try manager.removeSavedRecord(record) }
                removalRecord = nil
            }
        } message: { _ in
            Text("This removes the saved extension from your library. Original source files and Dock shortcuts are kept.")
        }
    }

    private func perform(_ operation: () throws -> Void) {
        do { try operation() }
        catch { manager.errorMessage = error.localizedDescription }
    }
}

private struct SavedExtensionSourceSheet: View {
    let record: ExtensionRecord
    @Environment(\.dismiss) private var dismiss
    @State private var selectedFile = 0

    private var sources: [StoredExtensionSource] {
        record.sourceFiles ?? [StoredExtensionSource(fileName: record.sourceFileName, type: record.sourceType, text: record.sourceText)]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(record.name).font(.title2.weight(.semibold))
            Picker("Source file", selection: $selectedFile) {
                ForEach(Array(sources.enumerated()), id: \.offset) { index, source in
                    Text(source.fileName).tag(index)
                }
            }
            ScrollView([.horizontal, .vertical]) {
                Text(sources[selectedFile].text)
                    .font(.system(size: 12, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(12)
            }
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            HStack {
                Text("Saved source · read only").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Copy Source") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(sources[selectedFile].text, forType: .string)
                }
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 700, height: 540)
    }
}
