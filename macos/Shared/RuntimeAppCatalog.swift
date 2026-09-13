import Foundation
import Darwin

public struct RuntimeAppDefinition: Codable, Hashable, Sendable {
    public struct RendererRuntime: Codable, Hashable, Sendable {
        public let engine: String
        public let verification: String
        private struct Key: CodingKey {
            let stringValue: String
            var intValue: Int? { nil }
            init?(stringValue: String) { self.stringValue = stringValue }
            init?(intValue: Int) { return nil }
        }
        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: Key.self)
            guard Set(values.allKeys.map(\.stringValue)) == ["engine", "verification"],
                  let engineKey = Key(stringValue: "engine"), let verificationKey = Key(stringValue: "verification") else {
                throw CocoaError(.fileReadCorruptFile)
            }
            engine = try values.decode(String.self, forKey: engineKey)
            verification = try values.decode(String.self, forKey: verificationKey)
            guard engine == "isolated-js-v1", verification == "not-verified" else { throw CocoaError(.fileReadCorruptFile) }
        }
    }
    public struct OwnedLocalService: Codable, Hashable, Sendable {
        public let executableRelativePath: String

        private struct Key: CodingKey {
            let stringValue: String
            var intValue: Int? { nil }
            init?(stringValue: String) { self.stringValue = stringValue }
            init?(intValue: Int) { return nil }
        }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: Key.self)
            guard values.allKeys.map(\.stringValue) == ["executableRelativePath"],
                  let key = Key(stringValue: "executableRelativePath") else {
                throw CocoaError(.fileReadCorruptFile)
            }
            executableRelativePath = try values.decode(String.self, forKey: key)
        }
    }
    public struct Target: Codable, Hashable, Sendable {
        public let urlPattern: String
        public let selector: String
    }
    public let slug: String
    public let name: String
    public let bundlePath: String
    public let bundleIdentifier: String
    public let executable: String
    public let transport: String
    public let arguments: [String]
    public let target: Target
    public let ownedLocalService: OwnedLocalService?
    public let rendererRuntime: RendererRuntime?

    private enum CodingKeys: String, CodingKey {
        case slug, name, bundlePath, bundleIdentifier, executable, transport, arguments, target, ownedLocalService, rendererRuntime
    }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        slug = try values.decode(String.self, forKey: .slug)
        name = try values.decode(String.self, forKey: .name)
        bundlePath = try values.decode(String.self, forKey: .bundlePath)
        bundleIdentifier = try values.decode(String.self, forKey: .bundleIdentifier)
        executable = try values.decode(String.self, forKey: .executable)
        transport = try values.decode(String.self, forKey: .transport)
        arguments = try values.decode([String].self, forKey: .arguments)
        target = try values.decode(Target.self, forKey: .target)
        ownedLocalService = try values.decodeIfPresent(OwnedLocalService.self, forKey: .ownedLocalService)
        // Missing means legacy CSS-only. Explicit null/malformed declarations
        // must not be silently treated as a valid capability configuration.
        rendererRuntime = values.contains(.rendererRuntime) ? try values.decode(RendererRuntime.self, forKey: .rendererRuntime) : nil
    }
}

public enum RuntimeAppCatalog {
    /// Installed app/helper bundles read their signed resource. SwiftPM tools
    /// use an adjacent CLI resource when packaged, or the checkout for SwiftPM.
    public static let entries: [RuntimeAppDefinition] = {
        let file: URL
        if Bundle.main.bundleURL.pathExtension == "app" {
            guard let resources = Bundle.main.resourceURL else { return [] }
            file = resources.appendingPathComponent("runtime-profiles.json")
        } else if let executable = Bundle.main.executableURL,
                  FileManager.default.fileExists(atPath: executable.deletingLastPathComponent()
                    .appendingPathComponent("runtime-profiles.json").path) {
            let adjacent = executable.deletingLastPathComponent().appendingPathComponent("runtime-profiles.json")
            guard adjacent.standardizedFileURL.resolvingSymlinksInPath().path == adjacent.path,
                  (try? adjacent.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { return [] }
            file = adjacent
        } else {
            file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("compatibility/runtime-profiles.json")
        }
        guard let data = try? Data(contentsOf: file), data.count <= 256 * 1024 else { return [] }
        return (try? decode(data)) ?? []
    }()

    public static func decode(_ data: Data) throws -> [RuntimeAppDefinition] {
        guard data.count <= 256 * 1024 else { throw CocoaError(.fileReadTooLarge) }
        let entries = try JSONDecoder().decode([RuntimeAppDefinition].self, from: data)
        guard entries.count <= 64,
              Set(entries.map(\.slug)).count == entries.count,
              Set(entries.map(\.bundlePath)).count == entries.count,
              Set(entries.map(\.bundleIdentifier)).count == entries.count else { throw CocoaError(.fileReadCorruptFile) }
        for entry in entries {
            let bundle = URL(fileURLWithPath: entry.bundlePath).standardizedFileURL
            let executable = URL(fileURLWithPath: entry.executable).standardizedFileURL
            var allowedArguments: Set<String> = entry.transport == "pipe"
                ? ["--remote-debugging-pipe"]
                : ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"]
            if entry.slug == "compass" { allowedArguments.insert("--ignoreAdditionalCommandLineFlags") }
            guard entry.slug.range(of: #"^[a-z][a-z0-9-]{0,63}$"#, options: .regularExpression) != nil,
                  !["stylelab", "chatgpt", "claude", "1password"].contains(entry.slug),
                  !entry.name.isEmpty, !entry.bundleIdentifier.isEmpty,
                  entry.bundlePath.hasPrefix("/Applications/"), entry.bundlePath == bundle.path,
                  bundle.pathExtension == "app", !entry.bundlePath.contains("/../"),
                  entry.executable == executable.path,
                  executable.path.hasPrefix(bundle.appendingPathComponent("Contents/MacOS").path + "/"),
                  ["pipe", "tcp", "launchservices-tcp"].contains(entry.transport),
                  entry.arguments.count <= 8,
                  Set(entry.arguments).count == entry.arguments.count,
                  entry.arguments.allSatisfy({ allowedArguments.contains($0) }),
                  entry.target.urlPattern.hasPrefix("^"), entry.target.urlPattern.hasSuffix("$"),
                  entry.target.urlPattern.utf8.count <= 2048,
                  (try? NSRegularExpression(pattern: entry.target.urlPattern)) != nil,
                  !entry.target.selector.isEmpty, entry.target.selector.utf8.count <= 1024 else {
                throw CocoaError(.fileReadCorruptFile)
            }
            if entry.slug == "antigravity" {
                guard entry.bundlePath == "/Applications/Antigravity.app",
                      entry.bundleIdentifier == "com.google.antigravity",
                      entry.executable == "/Applications/Antigravity.app/Contents/MacOS/Antigravity",
                      entry.transport == "pipe",
                      entry.ownedLocalService?.executableRelativePath == "Contents/Resources/bin/language_server",
                      entry.target.urlPattern == #"^https://127\.0\.0\.1:[1-9][0-9]{3,4}/$"#,
                      entry.target.selector == #"button[aria-label="Toggle Sidebar"][data-testid="sidebar-toggle"]"# else {
                    throw CocoaError(.fileReadCorruptFile)
                }
            } else if entry.ownedLocalService != nil {
                throw CocoaError(.fileReadCorruptFile)
            }
        }
        return entries
    }
}

/// The wrapper validates its own write location before creating any session.
/// A malformed adjacent configuration must never direct writes into an app.
public enum RuntimeLauncherConfigurationFiles {
    public static let maximumBytes = 64 * 1024

    private static func canonicalDirectory(_ directory: URL) throws -> URL {
        guard directory.isFileURL else { throw CocoaError(.fileReadCorruptFile) }
        let canonical = directory.standardizedFileURL.resolvingSymlinksInPath()
        guard !canonical.pathComponents.contains(where: { $0.lowercased().hasSuffix(".app") }) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return canonical
    }

    public static func read(in directory: URL) throws -> Data {
        let parent = try canonicalDirectory(directory)
        let file = parent.appendingPathComponent("configuration.json")
        // Refuse a substituted symlink, then inspect/read this exact open file.
        let descriptor = Darwin.open(file.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0,
              info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              info.st_size >= 0, info.st_size <= maximumBytes else { throw CocoaError(.fileReadCorruptFile) }
        var result = Data()
        while result.count <= maximumBytes {
            guard let chunk = try handle.read(upToCount: min(8192, maximumBytes + 1 - result.count)), !chunk.isEmpty else { break }
            result.append(chunk)
        }
        guard result.count <= maximumBytes else { throw CocoaError(.fileReadTooLarge) }
        return result
    }

    public static func sessionsDirectory(_ configuredPath: String, launcherDirectory: URL) throws -> URL {
        let parent = try canonicalDirectory(launcherDirectory)
        let expected = parent.appendingPathComponent("Sessions", isDirectory: true)
        guard configuredPath == expected.path,
              expected.standardizedFileURL.resolvingSymlinksInPath().path == expected.path else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return expected
    }
}
