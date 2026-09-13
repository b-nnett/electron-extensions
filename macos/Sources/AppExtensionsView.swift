import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct AppExtensionsView: View {
    let app: InstalledApp
    let icon: NSImage?
    @Bindable var manager: ExtensionManager
    var createExtension: () -> Void
    @State private var showingInfo = false
    @State private var showingImport = false
    @State private var inspectedExtension: ExtensionSelection?

    private var records: [ExtensionRecord] { manager.records(for: app) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Extensions").font(.system(size: 25, weight: .semibold))
                        if !records.isEmpty {
                            Text("\(records.count) installed · \(records.filter(\.isEnabled).count) enabled")
                                .font(.system(size: 13))
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 16)
                    Button { showingImport = true } label: {
                        Label("Add Extension", systemImage: "plus")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(manager.loadFailed)
                }

                Label(ExtensionCapabilities.authoringSummary(for: app), systemImage: "info.circle")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let notice = ExtensionCapabilities.runtimeTrustNotice(for: app) {
                    Text(notice).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if !records.isEmpty {
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        HStack(spacing: 8) {
                            Image(systemName: "circle.dashed")
                            Text(manager.launcher.status(app: app))
                            Spacer()
                        }
                    }
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                }

                if let notice = manager.dockNotice[app.id] {
                    Label(notice, systemImage: "checkmark.circle")
                        .font(.caption).foregroundStyle(.secondary)
                }

                if records.isEmpty {
                    Button { showingImport = true } label: {
                        VStack(spacing: 12) {
                            Image(systemName: "puzzlepiece.extension")
                                .font(.system(size: 32, weight: .light))
                                .foregroundStyle(.secondary)
                            Text("Add your first extension")
                                .font(.system(size: 16, weight: .medium))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 55)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .background(.primary.opacity(0.015), in: RoundedRectangle(cornerRadius: 14))
                    .overlay {
                        RoundedRectangle(cornerRadius: 14)
                            .strokeBorder(.secondary.opacity(0.25), style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                    }
                    .disabled(manager.loadFailed)
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: 16)], spacing: 16) {
                        ForEach(records) { record in
                            ExtensionCard(record: record, isEnabled: Binding(
                                get: { manager.record(record.id)?.isEnabled ?? false },
                                set: { manager.setEnabled($0, record: record, app: app) }
                            ), enablementIssue: ExtensionCapabilities.enablementIssue(for: record, app: app, records: records)) {
                                inspectedExtension = ExtensionSelection(id: record.id)
                            }
                        }
                    }
                }
            }
            .padding(28)
            .frame(maxWidth: 1080, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .navigationTitle("")
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 8) {
                    if let icon {
                        Image(nsImage: icon).resizable().scaledToFit().frame(width: 22, height: 22)
                    }
                    Text(app.name).font(.system(size: 13, weight: .semibold))
                }
                .padding(.horizontal, 10)
            }
            ToolbarItem(placement: .primaryAction) {
                Button { manager.open(app) } label: {
                    Text("Open App")
                        .padding(.horizontal, 10)
                }
                .help("Open \(app.name)")
            }
            ToolbarItem(placement: .primaryAction) {
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    Menu {
                        Button("Add to Dock") { manager.repairShortcut(app) }
                        if let directory = manager.launcher.sessionDirectory(app: app) {
                            Button("Show Session Logs") { NSWorkspace.shared.open(directory) }
                        }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .help("More options for \(app.name)")
                    .accessibilityLabel("More")
                }
                .fixedSize()
            }
            ToolbarItem(placement: .primaryAction) {
                Button { showingInfo = true } label: {
                    Image(systemName: "info.circle")
                }
                .help("About \(app.name)")
                .accessibilityLabel("About \(app.name)")
            }
        }
        .sheet(isPresented: $showingInfo) { AppInformationView(app: app, icon: icon) }
        .sheet(isPresented: $showingImport) {
            AddExtensionSheet(app: app, manager: manager) {
                showingImport = false
                createExtension()
            }
        }
        .sheet(item: $inspectedExtension) { selection in
            ExtensionDetailsSheet(app: app, extensionID: selection.id, manager: manager)
        }
    }
}

private struct ExtensionSelection: Identifiable { let id: UUID }

private struct ExtensionCard: View {
    let record: ExtensionRecord
    @Binding var isEnabled: Bool
    let enablementIssue: String?
    var openDetails: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Button(action: openDetails) {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 12) {
                        ExtensionGlyph(type: record.sourceType)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(record.name).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                            Text("\(record.sourceLabel) · \(record.fileCount) \(record.fileCount == 1 ? "file" : "files")").font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    Text(record.description.isEmpty ? "Custom \(record.sourceType.rawValue.uppercased()) extension." : record.description)
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .frame(maxWidth: .infinity, minHeight: 48, alignment: .topLeading)
                    if let enablementIssue {
                        Text(enablementIssue).font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open \(record.name)")
            Divider()
            HStack(spacing: 8) {
                Button("Details", action: openDetails).controlSize(.small)
                Spacer()
                Text(enablementIssue != nil ? "Cannot run" : isEnabled ? "Enabled" : "Disabled")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                Toggle("Enable \(record.name)", isOn: $isEnabled)
                    .labelsHidden().toggleStyle(.switch).controlSize(.small)
                    .disabled(!isEnabled && enablementIssue != nil)
                    .help(enablementIssue ?? "Enable or disable this extension")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(.primary.opacity(0.09)) }
    }
}

struct ExtensionGlyph: View {
    let type: ExtensionSourceType
    var body: some View {
        Image(systemName: type == .css ? "paintbrush.pointed" : "curlybraces")
            .font(.system(size: 20, weight: .medium))
            .foregroundStyle(type == .css ? Color.teal : Color.orange)
            .frame(width: 42, height: 42)
            .background((type == .css ? Color.teal : Color.orange).opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
            .accessibilityLabel(type.rawValue.uppercased())
    }
}

private struct AddExtensionSheet: View {
    let app: InstalledApp
    @Bindable var manager: ExtensionManager
    var createExtension: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var package: ImportedExtensionPackage?
    @State private var errorMessage: String?
    @State private var choosingFile = false
    @State private var adding = false

    private var importIssue: String? {
        package.flatMap { ExtensionCapabilities.importIssue(for: $0, app: app, records: manager.records(for: app)) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            Text("Add Extension").font(.system(size: 22, weight: .semibold))
            Text(ExtensionCapabilities.authoringSummary(for: app))
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let notice = ExtensionCapabilities.runtimeTrustNotice(for: app) {
                Text(notice).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button { choosingFile = true } label: {
                HStack(spacing: 12) {
                    Image(systemName: package == nil ? "doc.badge.plus" : "doc.text")
                        .font(.system(size: 22)).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(package?.manifestFileName ?? "Choose manifest.json…").fontWeight(.medium)
                        Text(package == nil ? "Select your extension’s JSON manifest" : "Choose a different manifest")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                }
                .padding(16)
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 10))
            .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(.secondary.opacity(0.2)) }
            .disabled(adding)

            if let package {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(package.manifest.name).font(.headline).lineLimit(2)
                        Spacer()
                        Text("v\(package.manifest.version)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Text(package.manifest.description).foregroundStyle(.secondary).lineLimit(4)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("\(package.sources.count) \(package.sources.count == 1 ? "file" : "files")")
                        .font(.caption).foregroundStyle(.tertiary)
                }
            }
            if let importIssue {
                Label("This extension will be saved disabled. \(importIssue)", systemImage: "info.circle")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.circle")
                    .font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button("Create your own") {
                    dismiss()
                    createExtension()
                }
                .buttonStyle(.link)
                .disabled(adding)
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(adding)
                Button(importIssue == nil ? "Add Extension" : "Save Disabled", action: add)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(package == nil || manager.loadFailed || adding)
            }
        }
        .padding(28)
        .frame(width: 480)
        .fileImporter(isPresented: $choosingFile, allowedContentTypes: [.json], allowsMultipleSelection: false) { result in
            do {
                guard let url = try result.get().first else { return }
                let accessing = url.startAccessingSecurityScopedResource()
                defer { if accessing { url.stopAccessingSecurityScopedResource() } }
                let imported = try ImportedExtensionPackage.load(from: url)
                package = imported
                errorMessage = nil
            } catch {
                package = nil
                errorMessage = error.localizedDescription
            }
        }
    }

    private func add() {
        guard let package, !adding else { return }
        let enabled = importIssue == nil
        adding = true
        errorMessage = nil
        Task { @MainActor in
            defer { adding = false }
            do {
                if try await manager.addWithRuntimeUpgrade(package: package, app: app, isEnabled: enabled) { dismiss() }
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
