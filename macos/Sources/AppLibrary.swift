import Foundation

struct InstalledApp: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let bundleIdentifier: String?
    let url: URL
}

enum ElectronAppDiscovery {
    static func scan(
        in directory: URL = URL(fileURLWithPath: "/Applications", isDirectory: true)
    ) throws -> [InstalledApp] {
        guard directory.isFileURL else {
            throw CocoaError(.fileReadUnsupportedScheme)
        }
        let root = directory.standardizedFileURL.resolvingSymlinksInPath()
        guard try root.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else {
            throw CocoaError(.fileReadUnknown, userInfo: [
                NSLocalizedDescriptionKey: "The application search location is not a directory."
            ])
        }

        let fileManager = FileManager.default
        let keys: Set<URLResourceKey> = [.isDirectoryKey, .isSymbolicLinkKey]
        var pending = [root]
        var found: [String: InstalledApp] = [:]

        while let folder = pending.popLast() {
            let children: [URL]
            do {
                children = try fileManager.contentsOfDirectory(
                    at: folder, includingPropertiesForKeys: Array(keys)
                )
            } catch {
                // A bad root is an error; an inaccessible nested folder should
                // not hide the other applications in the library.
                if folder == root { throw error }
                continue
            }

            for child in children {
                if child.pathExtension.caseInsensitiveCompare("app") == .orderedSame {
                    if let app = installedApp(at: child) { found[app.id] = app }
                    // Never descend into an app, including non-Electron apps:
                    // their nested helper apps are not standalone library items.
                    continue
                }
                guard let values = try? child.resourceValues(forKeys: keys),
                      values.isDirectory == true, values.isSymbolicLink != true else { continue }
                // App symlinks are resolved above. Ordinary directory symlinks
                // are not traversed, avoiding cycles or unrelated directory trees.
                pending.append(child)
            }
        }

        return found.values.sorted {
            let order = $0.name.localizedStandardCompare($1.name)
            return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
        }
    }

    private static func installedApp(at candidate: URL) -> InstalledApp? {
        let url = candidate.standardizedFileURL.resolvingSymlinksInPath()
        guard (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { return nil }
        let bundle = Bundle(url: url)
        let identifier = nonempty(bundle?.bundleIdentifier)
        // Explicit sidebar inclusion for the installed ChatGPT identity. This
        // is not an Electron architecture or runtime-customization assertion.
        let isKnownChatGPT = identifier == "com.openai.codex" &&
            nonempty(bundle?.object(forInfoDictionaryKey: "CFBundleExecutable") as? String) == "ChatGPT"
        let framework = url.appendingPathComponent("Contents/Frameworks/Electron Framework.framework")
            .standardizedFileURL.resolvingSymlinksInPath()
        let hasContainedElectronFramework = framework.path.hasPrefix(url.path + "/") &&
            (try? framework.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
        guard isKnownChatGPT || hasContainedElectronFramework else { return nil }

        // Match the name users see in Applications. For example, VS Code's
        // internal bundle name is just "Code" but its Finder name is clearer.
        let name = displayName(for: url)
        return InstalledApp(
            id: url.path, name: name,
            bundleIdentifier: identifier, url: url
        )
    }

    private static func displayName(for url: URL) -> String {
        let localized = (try? url.resourceValues(forKeys: [.localizedNameKey]).localizedName)
            ?? url.lastPathComponent
        if localized.lowercased().hasSuffix(".app") { return String(localized.dropLast(4)) }
        return localized
    }

    private static func nonempty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }
}

/// The JSON is the mapping itself: {"com.example.app": ["extension-id"]}.
/// Compatibility-test results are deliberately not an assignment source.
struct ExtensionAssignments: Codable, Sendable {
    var byBundleIdentifier: [String: [String]]

    init(byBundleIdentifier: [String: [String]] = [:]) {
        self.byBundleIdentifier = byBundleIdentifier
    }

    static var defaultURL: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return support.appendingPathComponent("Extensions Anywhere/extensions.json")
    }

    static func load(from url: URL = defaultURL) throws -> ExtensionAssignments {
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return ExtensionAssignments()
        }
        return try JSONDecoder().decode(ExtensionAssignments.self, from: data)
    }

    func hasExtensions(for app: InstalledApp) -> Bool {
        guard let identifier = app.bundleIdentifier else { return false }
        return byBundleIdentifier[identifier]?.contains {
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        } ?? false
    }

    init(from decoder: Decoder) throws {
        byBundleIdentifier = try decoder.singleValueContainer().decode([String: [String]].self)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(byBundleIdentifier)
    }
}
