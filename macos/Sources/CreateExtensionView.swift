import AppKit
import Observation
import SwiftUI
import UniformTypeIdentifiers

@MainActor
@Observable
final class ExtensionAuthoringDraft {
    static let maximumBriefBytes = 64 * 1024
    private static let maximumSnapshotBytes = 256 * 1024
    var brief: String { didSet { save() } }
    var projectFolder: URL? { didSet { save() } }
    var targetApp: InstalledApp? { didSet { save() } }
    var wasOpen: Bool { didSet { save() } }
    private(set) var persistenceError: String?
    @ObservationIgnored private let storageURL: URL
    @ObservationIgnored private var loadBlocked = false

    private struct Target: Codable {
        let name: String
        let bundleIdentifier: String?
        let url: URL
    }
    private struct Snapshot: Codable {
        let version: Int
        let brief: String
        let projectFolder: URL?
        let target: Target?
        let wasOpen: Bool
    }

    init(storageURL: URL = ExtensionLibrary.defaultURL.deletingLastPathComponent().appendingPathComponent("authoring-draft.json")) {
        self.storageURL = storageURL
        brief = ""
        projectFolder = nil
        targetApp = nil
        wasOpen = false
        do {
            let handle = try FileHandle(forReadingFrom: storageURL)
            defer { try? handle.close() }
            let data = try handle.read(upToCount: Self.maximumSnapshotBytes + 1) ?? Data()
            guard data.count <= Self.maximumSnapshotBytes else { throw CocoaError(.fileReadCorruptFile) }
            let snapshot = try JSONDecoder().decode(Snapshot.self, from: data)
            guard snapshot.version == 1, snapshot.brief.utf8.count <= Self.maximumBriefBytes,
                  snapshot.projectFolder == nil || snapshot.projectFolder?.isFileURL == true,
                  snapshot.target == nil || snapshot.target?.url.isFileURL == true else {
                throw CocoaError(.fileReadCorruptFile)
            }
            brief = snapshot.brief
            projectFolder = snapshot.projectFolder
            targetApp = snapshot.target.map { InstalledApp(id: $0.url.path, name: $0.name, bundleIdentifier: $0.bundleIdentifier, url: $0.url) }
            wasOpen = snapshot.wasOpen
        } catch let error as NSError where
            (error.domain == NSCocoaErrorDomain && [CocoaError.fileReadNoSuchFile.rawValue, CocoaError.fileNoSuchFile.rawValue].contains(error.code)) ||
            (error.domain == NSPOSIXErrorDomain && error.code == 2) {
            // A new installation has no draft yet.
        } catch {
            loadBlocked = true
            persistenceError = "Your saved draft couldn't be restored. The existing file was preserved. Copy your instructions before closing this window."
        }
    }

    private func save() {
        guard !loadBlocked else { return }
        guard brief.utf8.count <= Self.maximumBriefBytes else {
            persistenceError = "This draft is too large to save (64 KiB maximum). Shorten the description or copy your instructions before closing."
            return
        }
        do {
            let snapshot = Snapshot(version: 1, brief: brief, projectFolder: projectFolder,
                target: targetApp.map { Target(name: $0.name, bundleIdentifier: $0.bundleIdentifier, url: $0.url) }, wasOpen: wasOpen)
            let data = try JSONEncoder().encode(snapshot)
            guard data.count <= Self.maximumSnapshotBytes else { throw CocoaError(.fileWriteOutOfSpace) }
            try FileManager.default.createDirectory(at: storageURL.deletingLastPathComponent(), withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            try data.write(to: storageURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: storageURL.path)
            persistenceError = nil
        } catch {
            persistenceError = "Your draft couldn't be saved. Copy your instructions before closing this window. \(error.localizedDescription)"
        }
    }
}

enum ExtensionAuthoringInstructions {
    static func sourceSummary(app: InstalledApp?) -> String {
        guard let app else {
            return "Choose an app to see its configured CSS and JavaScript support."
        }
        guard let profile = ElectronLaunchProfile.profile(for: app) else {
            return "This app can store packages disabled; it has no configured CSS or JavaScript runtime."
        }
        return profile.supportsJavaScript
            ? "List CSS and JavaScript files. Register script cleanup with ea.onDispose."
            : "This app’s configured runtime accepts CSS. JavaScript files can be saved disabled."
    }

    static let manifestExample = """
    {
      "manifest_version": 1,
      "name": "My extension",
      "description": "Describe what your extension changes.",
      "version": "1.0.0",
      "css": ["styles.css"],
      "js": []
    }
    """

    static func text(app: InstalledApp?, brief: String, projectFolder: URL?) -> String {
        let target = app.map { "\($0.name) (\($0.bundleIdentifier ?? $0.url.path))" } ?? "the app chosen when importing"
        let installedSource = app.map {
            "Installed app bundle: \($0.url.path)\nStart by checking: \($0.url.appendingPathComponent("Contents/Resources/app.asar").path)"
        } ?? "Identify the intended installed app and its bundle path before investigating its packaged source."
        let task = brief.trimmingCharacters(in: .whitespacesAndNewlines)
        let profile = app.flatMap { ElectronLaunchProfile.profile(for: $0) }
        let supportsJavaScript = profile?.supportsJavaScript == true
        let scriptContract = supportsJavaScript ? """
        For this exact configured \(app?.name ?? "selected app") profile, authored JS receives lexical ea and console arguments. Use ea.id to scope your own element IDs. ea.signal aborts when the extension generation ends. Register cleanup with ea.onDispose(callback) before creating resources; it accepts synchronous or Promise-returning callbacks, runs them once in reverse order, and returns undefined. Remove your own DOM, listeners, observers and timers. Cleanup has a shared cooperative deadline (default 3 seconds); a failure blocks that extension's replacement until a fresh document. It cannot preempt synchronous infinite loops or undo arbitrary external side effects. Do not return a function as an implicit disposer. Use the attributed console.log/info/warn/error for short primitive diagnostics; never log private page content. Reload starts a fresh generation; do not reuse old document objects or duplicate handlers.
        """ : """
        JavaScript execution is unavailable for this selected target. Choose an installed app with a configured renderer JavaScript runtime before relying on ea or script execution. Packages may be stored disabled. Do not invent runtime hooks or assume Chrome APIs or a disposer exists in an unconfigured app. Explain required lifecycle behavior and cleanup limitations in the README.
        """
        let runtimeLimits = supportsJavaScript
            ? "This configured profile accepts CSS and renderer JavaScript: CSS is limited to 64 KiB combined UTF-8 including file separators; JavaScript is limited to 256 KiB combined UTF-8 across all enabled extensions. At most 64 enabled records and 32 files per record are accepted."
            : profile != nil
                ? "This selected profile accepts CSS only, with a 64 KiB combined UTF-8 stylesheet limit across all enabled extensions for the target app, including separators between source files. JavaScript and mixed packages can be saved disabled."
                : "No executable source limits apply until an app with a configured runtime is selected. Apps without a configured runtime can store packages disabled but cannot execute CSS or JavaScript."
        return """
        Create an extension package for Extensions Anywhere, targeting \(target).
        \(task.isEmpty ? "Ask what the extension should change before implementing it." : "Requested behavior: " + task)
        \(projectFolder.map { "Project folder: " + $0.path } ?? "Use a new folder for this extension.")

        \(installedSource)
        Before implementing, inspect the target app's app.asar to understand how the requested UI or behavior is implemented. Trace the relevant renderer components, DOM attributes, CSS selectors, styles, event handlers, and state changes. Use that source evidence to choose the smallest accurate extension instead of guessing selectors or behavior.
        Read the archive without changing it, or extract a copy into a research folder outside the installed .app. Check app.asar.unpacked for related files. If app.asar is absent, inspect equivalent packaged renderer assets when available and state what you could verify. Leave the installed app, archive, and signature unchanged.
        Record the installed app version, relevant source paths, and selector or behavior assumptions in the extension README. Distinguish source-based findings from runtime verification. Ship your authored extension files; keep extracted app source out of the package.

        Create manifest.json and its referenced source files in that folder.
        Use this manifest format (this is Extensions Anywhere's format):

        \(manifestExample)

        Replace the example name and description with accurate metadata, and set version to 1.0.0.
        manifest_version must be 1. name, description and version are required nonempty strings.
        css and js are optional arrays of relative file paths. Include at least one file across them.
        Every referenced file must exist, contain UTF-8 text, and have the matching .css or .js extension.
        Subfolders are allowed. Keep all referenced files inside the manifest folder; do not use absolute paths, parent-directory traversal, or links outside it.
        Package storage limits: manifest 64 KiB; source file 2 MiB; total source 8 MiB; at most 32 source files. These limits describe import/storage, not executable stylesheet size.

        Use plain CSS and browser JavaScript. This format does not provide Chrome extension APIs, background workers, Node.js, require(), or imports from npm. Bundle any needed browser code into the listed files. There is no permissions or network-resource manifest support.
        CSS files are ordered as listed; use specific selectors and preserve hover, focus, disabled, and light/dark states. Avoid broad selectors that hide unrelated controls. Prefer CSS-only changes when appearance is the goal.
        \(scriptContract)
        \(ExtensionCapabilities.authoringSummary(for: app))
        \(runtimeLimits)
        A configured profile is not evidence of compatibility with the installed app version. Verify outcomes separately and state what was actually checked. Owned fixture results do not establish support in other apps.
        Source files are copied at import; editing the original folder does not live-update the imported extension.

        Implement only the requested appearance or behavior in these source files. Scope CSS selectors to the intended controls. Keep JavaScript idempotent and use console.log/console.error for useful diagnostics without logging private app content.
        Do not modify, patch, re-sign, launch, or attach to the target app. Do not implement an injector or enable debugging. This task only creates the extension package.
        Validate the JSON and referenced files, check duplicate paths and UTF-8 byte limits, and include concise verification steps and known selector assumptions in a README. Then give me the full path to manifest.json so I can choose it in Extensions Anywhere's Add Extension sheet.
        """
    }
}

struct CreateExtensionView: View {
    let app: InstalledApp?
    @Bindable var draft: ExtensionAuthoringDraft
    @State private var tools: [InstalledCodingTool] = []
    @State private var icons: [String: NSImage] = [:]
    @State private var isScanning = true
    @State private var choosingFolder = false
    @State private var copied = false
    @State private var errorMessage: String?
    @State private var openingTool: String?
    @Environment(\.scenePhase) private var scenePhase

    private var instructions: String {
        ExtensionAuthoringInstructions.text(app: app, brief: draft.brief, projectFolder: draft.projectFolder)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                HStack {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Create Extension").font(.system(size: 25, weight: .semibold))
                        if let app { Text("For \(app.name)").font(.system(size: 13)).foregroundStyle(.secondary) }
                    }
                    Spacer()
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(instructions, forType: .string)
                        copied = true
                    } label: {
                        Label(copied ? "Copied" : "Copy Instructions", systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                    .controlSize(.large)
                }

                Label(ExtensionCapabilities.authoringSummary(for: app), systemImage: "info.circle")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let error = draft.persistenceError {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(alignment: .leading, spacing: 14) {
                    Text("Define your extension").font(.system(size: 16, weight: .semibold))
                    Text("Create a folder with a manifest.json file and the stylesheets or scripts it lists.")
                        .font(.system(size: 13)).foregroundStyle(.secondary)
                    Text(ExtensionAuthoringInstructions.manifestExample)
                        .font(.system(size: 12, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(18)
                        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
                        .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(.primary.opacity(0.07)) }
                    VStack(alignment: .leading, spacing: 7) {
                        instruction("Use name, description, and version for the extension’s details.")
                        instruction(ExtensionAuthoringInstructions.sourceSummary(app: app))
                        instruction("Enabled CSS across all extensions for one app must total 64 KiB or less.")
                        instruction("Inspect the app’s app.asar to understand its UI and behavior before writing your extension.")
                        instruction("Keep the files in this folder, then import manifest.json with Add Extension.")
                    }
                }

                Divider()

                VStack(alignment: .leading, spacing: 16) {
                    Text("Build with an agent").font(.system(size: 16, weight: .semibold))
                    TextField("Describe what your extension should do", text: $draft.brief, axis: .vertical)
                        .lineLimit(3...6)
                        .textFieldStyle(.plain)
                        .padding(12)
                        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                        .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(.primary.opacity(0.12)) }
                    HStack(spacing: 10) {
                        Image(systemName: "folder").foregroundStyle(.secondary)
                        Text(draft.projectFolder?.path ?? "Choose where to create your extension")
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 8)
                        Button(draft.projectFolder == nil ? "Choose Folder…" : "Change…") { choosingFolder = true }
                    }
                    if isScanning {
                        ProgressView().controlSize(.small)
                    } else if tools.isEmpty {
                        Text("No supported coding apps found in Applications. You can copy the instructions into your editor.")
                            .font(.system(size: 13)).foregroundStyle(.secondary)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(tools) { tool in
                                toolRow(tool)
                                if tool.id != tools.last?.id { Divider().padding(.leading, 60) }
                            }
                        }
                        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 12))
                        .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(.primary.opacity(0.07)) }
                    }
                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.circle")
                            .font(.caption).foregroundStyle(.red)
                    }
                }
            }
            .padding(28)
            .frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("")
        .toolbar {
            ToolbarItem(placement: .principal) {
                Label("Create Extension", systemImage: "puzzlepiece.extension")
                    .font(.system(size: 13, weight: .semibold))
                    .padding(.horizontal, 10)
            }
        }
        .task { await discoverTools() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await discoverTools() } }
        }
        .onChange(of: draft.brief) { _, _ in copied = false }
        .onChange(of: draft.projectFolder) { _, _ in copied = false }
        .onChange(of: app?.id) { _, _ in copied = false }
        .fileImporter(isPresented: $choosingFolder, allowedContentTypes: [.folder], allowsMultipleSelection: false) { result in
            do {
                draft.projectFolder = try result.get().first
                errorMessage = nil
            } catch { errorMessage = error.localizedDescription }
        }
    }

    private func instruction(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("•").foregroundStyle(.tertiary)
            Text(text).foregroundStyle(.secondary)
        }
        .font(.system(size: 12))
    }

    private func toolRow(_ tool: InstalledCodingTool) -> some View {
        HStack(spacing: 12) {
            if let icon = icons[tool.id] {
                Image(nsImage: icon).resizable().scaledToFit().frame(width: 32, height: 32)
            }
            VStack(alignment: .leading, spacing: 5) {
                Text(tool.name).font(.system(size: 13, weight: .medium))
                Text(tool.launchBehaviorSummary).font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            Button(openingTool == tool.id ? "Opening…" : "Open Task") { openTask(in: tool) }
                .disabled(draft.brief.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.projectFolder == nil || openingTool != nil)
                .help("Open your instructions in \(tool.name)")
        }
        .padding(16)
    }

    private func discoverTools() async {
        do {
            let found = try await Task.detached(priority: .utility) { try CodingToolDiscovery.scan() }.value
            tools = found
            icons = Dictionary(uniqueKeysWithValues: found.map { ($0.id, NSWorkspace.shared.icon(forFile: $0.appURL.path)) })
        } catch { errorMessage = error.localizedDescription }
        isScanning = false
    }

    private func openTask(in tool: InstalledCodingTool) {
        do {
            let url = try tool.taskURL(prompt: instructions, workingDirectory: draft.projectFolder)
            openingTool = tool.id
            errorMessage = nil
            Task { @MainActor in
                do {
                    let configuration = NSWorkspace.OpenConfiguration()
                    configuration.activates = true
                    _ = try await NSWorkspace.shared.open([url], withApplicationAt: tool.appURL, configuration: configuration)
                } catch { errorMessage = error.localizedDescription }
                openingTool = nil
            }
        } catch { errorMessage = error.localizedDescription }
    }
}
