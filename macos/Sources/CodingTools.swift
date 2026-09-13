import Foundation

enum CodingToolLaunchBehavior: String, Sendable {
    case opensDraft = "Opens a draft"
    case opensProject = "Opens a project"
}

/// Only routes described in the vendors' public documentation belong here.
/// A registered URL scheme alone does not establish a task-launch interface.
enum CodingToolKind: String, CaseIterable, Sendable {
    case codex
    case claude
    case cursor
    case visualStudioCode

    var name: String {
        switch self {
        case .codex: "Codex"
        case .claude: "Claude Code in Claude Desktop"
        case .cursor: "Cursor"
        case .visualStudioCode: "Visual Studio Code"
        }
    }

    var bundleIdentifier: String {
        switch self {
        case .codex: "com.openai.codex"
        case .claude: "com.anthropic.claudefordesktop"
        case .cursor: "com.todesktop.230313mzl4w4u92"
        case .visualStudioCode: "com.microsoft.VSCode"
        }
    }

    var urlScheme: String {
        switch self {
        case .codex: "codex"
        case .claude: "claude"
        case .cursor: "cursor"
        case .visualStudioCode: "vscode"
        }
    }

    var launchBehavior: CodingToolLaunchBehavior {
        self == .visualStudioCode ? .opensProject : .opensDraft
    }

    var supportsPrefilledTask: Bool { launchBehavior == .opensDraft }
    var supportsWorkingDirectory: Bool { self != .cursor }
    var automaticallySubmits: Bool { false }

    var launchBehaviorSummary: String {
        switch self {
        case .codex:
            "Opens a draft in the selected workspace. Review and send it in Codex."
        case .claude:
            "Opens a Claude Code draft. Confirm the folder, then review and send it in Claude."
        case .cursor:
            "Opens a draft in Cursor’s current workspace. Choose the correct project, then review and send it."
        case .visualStudioCode:
            "Opens the project only. The task is not prefilled or sent to an agent."
        }
    }

    var sourceURL: URL {
        switch self {
        case .codex:
            URL(string: "https://learn.chatgpt.com/docs/reference/commands#deep-links")!
        case .claude:
            URL(string: "https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link")!
        case .cursor:
            URL(string: "https://cursor.com/docs/reference/deeplinks")!
        case .visualStudioCode:
            URL(string: "https://code.visualstudio.com/docs/configure/command-line#_opening-vs-code-with-urls")!
        }
    }
}

struct InstalledCodingTool: Identifiable, Hashable, Sendable {
    let kind: CodingToolKind
    let name: String
    let appURL: URL
    let bundleIdentifier: String

    var id: String { appURL.path }
    var launchBehavior: CodingToolLaunchBehavior { kind.launchBehavior }
    var launchBehaviorSummary: String { kind.launchBehaviorSummary }
    var sourceURL: URL { kind.sourceURL }
    var supportsPrefilledTask: Bool { kind.supportsPrefilledTask }
    var supportsWorkingDirectory: Bool { kind.supportsWorkingDirectory }
    var automaticallySubmits: Bool { kind.automaticallySubmits }

    /// Constructs a URL only. The caller decides when to open it with the
    /// explicitly selected application; this type never starts an app or task.
    func taskURL(prompt: String, workingDirectory: URL? = nil) throws -> URL {
        if supportsPrefilledTask && prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw CodingToolError.emptyPrompt
        }
        let directory = try workingDirectory.map(Self.localDirectory)
        var components = URLComponents()
        components.scheme = kind.urlScheme

        switch kind {
        case .codex:
            components.host = "threads"
            components.path = "/new"
            components.queryItems = [URLQueryItem(name: "prompt", value: prompt)]
            if let directory {
                components.queryItems?.append(URLQueryItem(name: "path", value: directory.path))
            }
        case .claude:
            // The vendor truncates around 14,000 characters. Refuse oversized
            // prompts instead of silently discarding part of the task.
            guard prompt.utf16.count <= 14_000 else {
                throw CodingToolError.promptTooLong(tool: name, limit: 14_000)
            }
            components.host = "code"
            components.path = "/new"
            components.queryItems = [URLQueryItem(name: "q", value: prompt)]
            if let directory {
                components.queryItems?.append(URLQueryItem(name: "folder", value: directory.path))
            }
        case .cursor:
            components.host = "anysphere.cursor-deeplink"
            components.path = "/prompt"
            components.queryItems = [URLQueryItem(name: "text", value: prompt)]
            // No working-directory parameter is documented for this route.
            // The public capability and summary make this limitation explicit.
        case .visualStudioCode:
            guard let directory else { throw CodingToolError.workingDirectoryRequired }
            components.host = "file"
            components.path = directory.path.hasSuffix("/") ? directory.path : directory.path + "/"
        }

        // Some receivers interpret '+' using form-query conventions. Preserve
        // literal plus signs as data, alongside URLComponents' normal escaping.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let url = components.url else { throw CodingToolError.invalidURL }
        if kind == .cursor && url.absoluteString.utf8.count > 8_000 {
            throw CodingToolError.urlTooLong(tool: name, limit: 8_000)
        }
        return url
    }

    private static func localDirectory(_ url: URL) throws -> URL {
        guard url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost",
              url.query == nil, url.fragment == nil, (url.path as NSString).isAbsolutePath else {
            throw CodingToolError.invalidWorkingDirectory
        }
        let directory = url.standardizedFileURL
        guard (try? directory.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else {
            throw CodingToolError.invalidWorkingDirectory
        }
        return directory
    }
}

enum CodingToolError: LocalizedError, Equatable {
    case emptyPrompt
    case invalidWorkingDirectory
    case workingDirectoryRequired
    case promptTooLong(tool: String, limit: Int)
    case urlTooLong(tool: String, limit: Int)
    case invalidURL

    var errorDescription: String? {
        switch self {
        case .emptyPrompt: "Enter a task before opening a coding tool."
        case .invalidWorkingDirectory: "Choose an existing local project folder."
        case .workingDirectoryRequired: "Visual Studio Code requires a project folder for this link."
        case let .promptTooLong(tool, limit): "The task is too long for \(tool)’s link (maximum \(limit) characters)."
        case let .urlTooLong(tool, limit): "The encoded task link exceeds \(tool)’s \(limit)-character limit."
        case .invalidURL: "The coding-tool link could not be created."
        }
    }
}

enum CodingToolDiscovery {
    /// Includes project-only fallbacks only when a caller explicitly requests
    /// them. No Electron requirement: current ChatGPT/Codex is a native app.
    static func scan(
        in directory: URL = URL(fileURLWithPath: "/Applications", isDirectory: true),
        includeProjectOnly: Bool = false
    ) throws -> [InstalledCodingTool] {
        guard directory.isFileURL else { throw CocoaError(.fileReadUnsupportedScheme) }
        let root = directory.standardizedFileURL.resolvingSymlinksInPath()
        guard try root.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else {
            throw CocoaError(.fileReadUnknown)
        }
        let keys: Set<URLResourceKey> = [.isDirectoryKey, .isSymbolicLinkKey]
        var pending = [root]
        var found: [String: InstalledCodingTool] = [:]
        while let folder = pending.popLast() {
            let children: [URL]
            do {
                children = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: Array(keys))
            } catch {
                if folder == root { throw error }
                continue
            }
            for child in children {
                if child.pathExtension.caseInsensitiveCompare("app") == .orderedSame {
                    if let tool = installedTool(at: child), includeProjectOnly || tool.supportsPrefilledTask {
                        found[tool.id] = tool
                    }
                    continue // Nested helpers are never independent tools.
                }
                guard let values = try? child.resourceValues(forKeys: keys),
                      values.isDirectory == true, values.isSymbolicLink != true else { continue }
                pending.append(child)
            }
        }
        return found.values.sorted {
            let order = $0.name.localizedStandardCompare($1.name)
            return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
        }
    }

    private static func installedTool(at candidate: URL) -> InstalledCodingTool? {
        let url = candidate.standardizedFileURL.resolvingSymlinksInPath()
        guard (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true,
              let data = try? Data(contentsOf: url.appendingPathComponent("Contents/Info.plist")),
              let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
              let identifier = plist["CFBundleIdentifier"] as? String,
              let kind = CodingToolKind.allCases.first(where: { $0.bundleIdentifier == identifier }) else { return nil }
        let schemes = (plist["CFBundleURLTypes"] as? [[String: Any]] ?? [])
            .flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        guard schemes.contains(where: { $0.caseInsensitiveCompare(kind.urlScheme) == .orderedSame }) else { return nil }
        let name = kind == .codex && url.deletingPathExtension().lastPathComponent == "ChatGPT"
            ? "ChatGPT (Codex)" : kind.name
        return InstalledCodingTool(kind: kind, name: name, appURL: url, bundleIdentifier: identifier)
    }
}
