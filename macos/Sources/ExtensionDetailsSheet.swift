import AppKit
import SwiftUI

struct ExtensionDetailsSheet: View {
    let app: InstalledApp
    let extensionID: UUID
    @Bindable var manager: ExtensionManager
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingRemoval = false
    @State private var errorMessage: String?
    @State private var copiedLogs = false
    @State private var selectedLog = LogKind.runtime
    @State private var runtimeLogs = ExtensionRuntimeLogSnapshot.empty

    private enum LogKind: String, CaseIterable {
        case runtime = "Runtime", library = "Library"
    }

    private var record: ExtensionRecord? { manager.record(extensionID) }
    private var logs: [ExtensionManagementLog] { manager.library.logs(for: extensionID) }
    private var displayedLogCount: Int { selectedLog == .runtime ? runtimeLogs.events.count : logs.count }
    private var enablementIssue: String? {
        record.flatMap { ExtensionCapabilities.enablementIssue(for: $0, app: app, records: manager.records(for: app)) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let record {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(alignment: .top, spacing: 14) {
                        ExtensionGlyph(type: record.sourceType)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(record.name).font(.system(size: 22, weight: .semibold)).lineLimit(2)
                            Text("\(app.name) · \(record.sourceLabel)\(record.manifestVersion.map { " · v\($0)" } ?? "")")
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Toggle("Enabled", isOn: Binding(
                            get: { self.record?.isEnabled ?? false },
                            set: { manager.setEnabled($0, record: record, app: app) }
                        ))
                        .toggleStyle(.switch).controlSize(.small)
                        .disabled(!record.isEnabled && enablementIssue != nil)
                        .help(enablementIssue ?? "Enable or disable this extension")
                    }
                    if let enablementIssue {
                        Label(enablementIssue, systemImage: "info.circle")
                            .font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if !record.description.isEmpty {
                        Text(record.description)
                            .font(.system(size: 13)).foregroundStyle(.secondary)
                            .lineLimit(4).textSelection(.enabled)
                    }
                    HStack(spacing: 14) {
                        Label(record.fileCount == 1 ? record.sourceFileName : "\(record.fileCount) source files", systemImage: "doc.text")
                            .lineLimit(1).truncationMode(.middle)
                        Spacer()
                        Text("Added \(record.createdAt.formatted(date: .abbreviated, time: .omitted))")
                    }
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                .padding(24)

                Divider()

                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("Logs").font(.system(size: 15, weight: .semibold))
                        Picker("Log source", selection: $selectedLog) {
                            ForEach(LogKind.allCases, id: \.self) { kind in Text(kind.rawValue).tag(kind) }
                        }
                        .pickerStyle(.segmented).labelsHidden().frame(width: 180)
                        Spacer()
                        Text("\(displayedLogCount) events").font(.caption).foregroundStyle(.secondary)
                    }
                    Text(selectedLog == .runtime
                         ? "Script output from the latest recorded session. Logs don’t indicate a current connection."
                         : "Import, enable preferences and removal activity. These events don’t confirm execution.")
                        .font(.caption).foregroundStyle(.secondary)
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            if selectedLog == .runtime {
                                if let issue = runtimeLogs.issue {
                                    Label(issue, systemImage: "exclamationmark.triangle")
                                        .foregroundStyle(.secondary).padding(16)
                                } else if runtimeLogs.events.isEmpty {
                                    Text("No runtime logs recorded.")
                                        .foregroundStyle(.secondary).padding(16)
                                }
                                ForEach(runtimeLogs.events) { log in
                                    runtimeLogRow(log)
                                }
                            } else {
                                if logs.isEmpty {
                                    Text("No library activity recorded.")
                                        .foregroundStyle(.secondary).padding(16)
                                }
                                ForEach(logs) { log in
                                    HStack(alignment: .top, spacing: 12) {
                                        Text(log.timestamp.formatted(date: .omitted, time: .standard))
                                            .foregroundStyle(.tertiary)
                                            .frame(width: 78, alignment: .leading)
                                        Text(log.event)
                                            .foregroundStyle(.secondary)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    .font(.system(size: 11, design: .monospaced))
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 11)
                                    Divider().opacity(0.5)
                                }
                            }
                        }
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                    .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(.primary.opacity(0.08)) }
                }
                .padding(24)
                .frame(maxHeight: .infinity)

                if let errorMessage {
                    Text(errorMessage).font(.caption).foregroundStyle(.red)
                        .padding(.horizontal, 24).padding(.bottom, 12)
                }
                Divider()
                HStack {
                    Button("Remove Extension", role: .destructive) { confirmingRemoval = true }
                        .confirmationDialog("Remove \(record.name)?", isPresented: $confirmingRemoval, titleVisibility: .visible) {
                            Button("Remove Extension", role: .destructive) {
                                do {
                                    try manager.remove(record, app: app)
                                    dismiss()
                                } catch {
                                    errorMessage = error.localizedDescription
                                }
                            }
                        } message: {
                            Text("This removes it from your library. The original source file is kept.")
                        }
                    Spacer()
                    Button(copiedLogs ? "Copied" : "Copy Logs") {
                        let text = selectedLog == .runtime
                            ? runtimeLogs.events.map(\.copiedLine).joined(separator: "\n")
                            : logs.map { "[\($0.timestamp.formatted(date: .numeric, time: .standard))] \($0.event)" }.joined(separator: "\n")
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(text, forType: .string)
                        copiedLogs = true
                    }
                    .disabled(displayedLogCount == 0)
                    Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
                }
                .padding(20)
            } else {
                ContentUnavailableView("Extension removed", systemImage: "puzzlepiece.extension")
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction).padding(20)
            }
        }
        .frame(width: 650, height: 570)
        .onChange(of: selectedLog) { _, _ in copiedLogs = false }
        .onChange(of: runtimeLogs) { _, _ in copiedLogs = false }
        .task(id: extensionID) { await refreshRuntimeLogs() }
    }

    private func runtimeLogRow(_ log: ExtensionRuntimeLog) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(log.timestamp.formatted(date: .omitted, time: .standard))
                .foregroundStyle(.tertiary).frame(width: 78, alignment: .leading)
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(log.level.rawValue.uppercased())
                        .foregroundStyle(log.level == .error ? Color.red : log.level == .warn ? Color.orange : Color.secondary)
                    Text(log.fileName).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
                Text(log.message).frame(maxWidth: .infinity, alignment: .leading)
                Text("Revision \(log.revision)").foregroundStyle(.tertiary)
            }
        }
        .font(.system(size: 11, design: .monospaced))
        .padding(.horizontal, 14).padding(.vertical, 11)
        .overlay(alignment: .bottom) { Divider().opacity(0.5) }
    }

    @MainActor
    private func refreshRuntimeLogs() async {
        while !Task.isCancelled {
            guard let record, record.appKey == ExtensionLibrary.appKey(for: app) else { return }
            let sources = record.sourceFiles ?? [.init(fileName: record.sourceFileName, type: record.sourceType, text: record.sourceText)]
            let request = ExtensionRuntimeLogs.Request(
                sessionDirectory: manager.launcher.sessionDirectory(app: app),
                appKey: record.appKey, extensionID: extensionID,
                sourceFileNames: Set(sources.filter { $0.type == .js }.map(\.fileName)))
            let snapshot = await Task.detached(priority: .utility) { ExtensionRuntimeLogs.load(request) }.value
            guard !Task.isCancelled else { return }
            runtimeLogs = snapshot
            do { try await Task.sleep(for: .seconds(1)) }
            catch { return }
        }
    }
}
