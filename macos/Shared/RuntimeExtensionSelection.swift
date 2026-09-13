import Foundation

/// Shared manager/launcher validation of stored text. Source names are labels,
/// never filesystem paths to open. JS capability requires an explicit profile;
/// a stored app identifier alone never selects a mixed-source policy.
public enum RuntimeExtensionSelection {
    public static let styleLabIdentifier = "dev.extensionsanywhere.stylelab"
    public static let visualStudioCodeIdentifier = "com.microsoft.VSCode"
    public static let figmaIdentifier = "com.figma.Desktop"
    public static let chatgptIdentifier = "com.openai.codex"
    public static let claudeIdentifier = "com.anthropic.claudefordesktop"
    public static let maximumLibraryBytes = 64 * 1024 * 1024
    public static let maximumEnabledRecords = 64
    public static let maximumFilesPerRecord = 32
    public static let maximumCSSBytes = 64 * 1024
    public static let maximumJavaScriptBytes = 256 * 1024
    public static let maximumLabelBytes = 256

    public enum Policy: Equatable, Sendable { case cssOnly, styleLabMixed, chatgptMixed, claudeMixed, catalogMixed(targetIdentifier: String) }

    /// A configured engine is distinct from per-app verification. Only a fully
    /// validated bundled profile can bind its exact target ID to mixed selection.
    /// Existing document-specific adapters keep their narrower identity/routes.
    public static func catalogPolicy(for app: RuntimeAppDefinition) -> Policy {
        guard app.rendererRuntime?.engine == "isolated-js-v1", app.rendererRuntime?.verification == "not-verified",
              let encoded = try? JSONEncoder().encode([app]), (try? RuntimeAppCatalog.decode(encoded))?.count == 1 else { return .cssOnly }
        let standardArguments: Set<String> = ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"]
        if app.slug == "vscode" || app.bundleIdentifier == visualStudioCodeIdentifier || app.bundlePath == "/Applications/Visual Studio Code.app" {
            guard app.slug == "vscode", app.name == "Visual Studio Code",
              app.bundleIdentifier == visualStudioCodeIdentifier,
              app.bundlePath == "/Applications/Visual Studio Code.app",
              app.executable == "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
              app.transport == "tcp", app.ownedLocalService == nil,
              Set(app.arguments).isSubset(of: standardArguments),
              app.target.urlPattern == #"^vscode\-file:[^?#\r\n]+$"#,
              app.target.selector == #".monaco-workbench [role="button"][aria-label="Manage"]"# else { return .cssOnly }
        }
        if app.slug == "figma" || app.bundleIdentifier == figmaIdentifier || app.bundlePath == "/Applications/Figma.app" {
            guard app.slug == "figma", app.name == "Figma",
              app.bundleIdentifier == figmaIdentifier,
              app.bundlePath == "/Applications/Figma.app",
              app.executable == "/Applications/Figma.app/Contents/MacOS/Figma",
              app.transport == "pipe", app.ownedLocalService == nil, app.arguments.allSatisfy({ $0 == "--remote-debugging-pipe" }),
              app.target.urlPattern == #"^https://www\.figma\.com/[^?#\r\n]*$"#,
              app.target.selector == #"button[type="submit"]"# else { return .cssOnly }
        }
        return .catalogMixed(targetIdentifier: app.bundleIdentifier)
    }

    public enum ValidationError: LocalizedError, Equatable {
        case invalidLibrary, invalidRecord, invalidSource, inconsistentFirstSource
        case tooManyRecords, tooManyFiles, unsupportedJavaScript, wrongMixedTarget
        case cssTooLarge, javaScriptTooLarge, emptyCSS, emptyMixedSources

        public var errorDescription: String? {
            switch self {
            case .invalidLibrary: "The extension library is invalid or exceeds 64 MiB."
            case .invalidRecord: "Enabled extensions must have unique UUIDs, names, and the selected app identifier."
            case .invalidSource: "Enabled source files need unique relative CSS or JavaScript labels of at most 256 UTF-8 bytes."
            case .inconsistentFirstSource: "The package and its saved first-source fields disagree. Import the package again."
            case .tooManyRecords: "Enable no more than 64 extensions for one app."
            case .tooManyFiles: "An enabled extension can contain no more than 32 source files."
            case .unsupportedJavaScript: "This launch profile supports CSS extensions only."
            case .wrongMixedTarget: "JavaScript requires the exact application identifier bound by the selected configured launch profile."
            case .cssTooLarge: "Enabled stylesheets must total 64 KiB or less."
            case .javaScriptTooLarge: "Enabled JavaScript files must total 256 KiB or less."
            case .emptyCSS: "Add a nonempty stylesheet before launching with a tweak."
            case .emptyMixedSources: "Add a nonempty stylesheet or JavaScript file before launching with a tweak."
            }
        }
    }

    public struct Source: Codable, Equatable, Sendable {
        public let fileName: String
        public let type: String
        public let text: String
        public init(fileName: String, type: String, text: String) {
            self.fileName = fileName; self.type = type; self.text = text
        }
    }

    public struct Record: Codable, Sendable {
        public let id: String
        public let appKey: String
        public let name: String
        public let isEnabled: Bool
        public let sourceFileName: String
        public let sourceType: String
        public let sourceText: String
        public let sourceFiles: [Source]?
        public init(id: String, appKey: String, name: String, isEnabled: Bool,
                    sourceFileName: String, sourceType: String, sourceText: String, sourceFiles: [Source]? = nil) {
            self.id = id; self.appKey = appKey; self.name = name; self.isEnabled = isEnabled
            self.sourceFileName = sourceFileName; self.sourceType = sourceType
            self.sourceText = sourceText; self.sourceFiles = sourceFiles
        }
    }

    public struct EnabledRecord: Sendable {
        public let id: UUID
        public let name: String
        public let files: [Source]
    }

    public struct Selection: Sendable {
        public let records: [EnabledRecord]
        public let css: String
        public let cssBytes: Int
        public let javaScriptBytes: Int
        public let hasContent: Bool
        public var enabledExtensionIDs: [UUID] { records.map(\.id) }
    }

    public static func select(records: [Record], targetIdentifier: String, policy: Policy) throws -> Selection {
        guard !targetIdentifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ValidationError.invalidRecord }
        guard policy != .styleLabMixed || targetIdentifier == styleLabIdentifier else { throw ValidationError.wrongMixedTarget }
        guard policy != .chatgptMixed || targetIdentifier == chatgptIdentifier else { throw ValidationError.wrongMixedTarget }
        guard policy != .claudeMixed || targetIdentifier == claudeIdentifier else { throw ValidationError.wrongMixedTarget }
        if case .catalogMixed(let configuredIdentifier) = policy, targetIdentifier != configuredIdentifier { throw ValidationError.wrongMixedTarget }
        var selected: [EnabledRecord] = [], ids = Set<UUID>(), cssParts: [String] = []
        var cssBytes = 0, javaScriptBytes = 0, hasContent = false
        for record in records {
            guard !record.appKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ValidationError.invalidRecord }
            guard record.appKey == targetIdentifier, record.isEnabled else { continue }
            guard selected.count < maximumEnabledRecords else { throw ValidationError.tooManyRecords }
            guard let id = UUID(uuidString: record.id), ids.insert(id).inserted,
                  !record.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ValidationError.invalidRecord }
            if policy == .cssOnly && record.sourceType == "js" { throw ValidationError.unsupportedJavaScript }
            let sources = record.sourceFiles ?? [Source(fileName: record.sourceFileName, type: record.sourceType, text: record.sourceText)]
            guard !sources.isEmpty else { throw ValidationError.invalidSource }
            guard sources.count <= maximumFilesPerRecord else { throw ValidationError.tooManyFiles }
            guard let first = sources.first,
                  (first.fileName as NSString).lastPathComponent == record.sourceFileName,
                  first.type == record.sourceType, first.text == record.sourceText else { throw ValidationError.inconsistentFirstSource }
            var names = Set<String>()
            for source in sources {
                if policy == .cssOnly && source.type == "js" { throw ValidationError.unsupportedJavaScript }
                guard ["css", "js"].contains(source.type), validLabel(source.fileName),
                      (source.fileName as NSString).pathExtension.lowercased() == source.type,
                      names.insert(source.fileName).inserted else { throw ValidationError.invalidSource }
                let size = source.text.utf8.count
                if source.type == "css" {
                    let separator = cssParts.isEmpty ? 0 : 1
                    guard size <= maximumCSSBytes - cssBytes - separator else { throw ValidationError.cssTooLarge }
                    cssBytes += size + separator
                    cssParts.append(source.text)
                } else {
                    // Scripts execute separately; JS has no artificial join bytes.
                    guard size <= maximumJavaScriptBytes - javaScriptBytes else { throw ValidationError.javaScriptTooLarge }
                    javaScriptBytes += size
                }
                hasContent = hasContent || !source.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            selected.append(EnabledRecord(id: id, name: record.name, files: sources))
        }
        if !selected.isEmpty && !hasContent {
            throw policy == .cssOnly ? ValidationError.emptyCSS : ValidationError.emptyMixedSources
        }
        return Selection(records: selected, css: cssParts.joined(separator: "\n"), cssBytes: cssBytes,
                         javaScriptBytes: javaScriptBytes, hasContent: hasContent)
    }

    public static func decodeLibrary(_ data: Data, targetIdentifier: String, policy: Policy) throws -> Selection {
        guard data.count <= maximumLibraryBytes else { throw ValidationError.invalidLibrary }
        let library: StoredLibrary
        do { library = try JSONDecoder().decode(StoredLibrary.self, from: data) }
        catch { throw ValidationError.invalidLibrary }
        guard library.schemaVersion == nil || library.schemaVersion == 1 else { throw ValidationError.invalidLibrary }
        return try select(records: library.records, targetIdentifier: targetIdentifier, policy: policy)
    }

    private struct StoredLibrary: Decodable {
        let schemaVersion: Int?
        let records: [Record]
    }

    private static func validLabel(_ name: String) -> Bool {
        guard !name.isEmpty, name.utf8.count <= maximumLabelBytes,
              !name.contains("\\"), !name.contains(":"),
              !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return false }
        return name.split(separator: "/", omittingEmptySubsequences: false)
            .allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }
}
