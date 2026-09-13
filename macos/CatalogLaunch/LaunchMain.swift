import AppKit
import Darwin
import Foundation
import RuntimeCatalog

private struct LaunchOptions {
    let slug: String
    let port: UInt16

    init(_ arguments: [String]) throws {
        guard arguments.count == 4 else { throw launchError("Usage: CatalogAppLaunch --app <catalog slug> --port <1...65535>") }
        var values: [String: String] = [:]
        for index in stride(from: 0, to: arguments.count, by: 2) {
            let flag = arguments[index]
            guard ["--app", "--port"].contains(flag), values[flag] == nil else {
                throw launchError("Only one --app and one --port are accepted.")
            }
            values[flag] = arguments[index + 1]
        }
        guard let slug = values["--app"],
              slug.range(of: #"^[a-z][a-z0-9-]{0,63}$"#, options: .regularExpression) != nil,
              let rawPort = values["--port"],
              rawPort.range(of: #"^[0-9]{1,5}$"#, options: .regularExpression) != nil,
              let port = UInt16(rawPort), port > 0 else {
            throw launchError("Use a catalog app slug and a TCP port from 1 through 65535.")
        }
        self.slug = slug
        self.port = port
    }
}

private func launchError(_ message: String) -> NSError {
    NSError(domain: "ExtensionsAnywhere.CatalogAppLaunch", code: 1,
            userInfo: [NSLocalizedDescriptionKey: message])
}

private func canonical(_ url: URL) -> URL {
    url.standardizedFileURL.resolvingSymlinksInPath()
}

private func definitions() throws -> [RuntimeAppDefinition] {
    // A raw executable in Contents/Resources is not necessarily Bundle.main's
    // executable. Read its adjacent signed catalog explicitly when packaged.
    let executable = canonical(URL(fileURLWithPath: CommandLine.arguments[0]))
    let resources = executable.deletingLastPathComponent()
    if resources.lastPathComponent == "Resources",
       resources.deletingLastPathComponent().lastPathComponent == "Contents",
       resources.deletingLastPathComponent().deletingLastPathComponent().pathExtension == "app" {
        let file = resources.appendingPathComponent("runtime-profiles.json")
        let metadata = try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard metadata.isRegularFile == true, let size = metadata.fileSize, size <= 256 * 1024,
              canonical(file).deletingLastPathComponent().path == resources.path else {
            throw launchError("The packaged runtime catalog is missing or invalid.")
        }
        return try RuntimeAppCatalog.decode(Data(contentsOf: file))
    }
    return RuntimeAppCatalog.entries
}

@MainActor
private final class LaunchDelegate: NSObject, NSApplicationDelegate {
    private let definition: RuntimeAppDefinition
    private let port: UInt16
    private var timeout: Timer?
    private var finished = false

    init(definition: RuntimeAppDefinition, port: UInt16) {
        self.definition = definition
        self.port = port
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let bundle = URL(fileURLWithPath: definition.bundlePath, isDirectory: true)
            let executable = URL(fileURLWithPath: definition.executable)
            guard canonical(bundle).path == definition.bundlePath,
                  canonical(executable).path == definition.executable,
                  executable.path.hasPrefix(bundle.appendingPathComponent("Contents/MacOS").path + "/") else {
                throw launchError("The catalog app's installed path or executable changed.")
            }
            let infoData = try Data(contentsOf: bundle.appendingPathComponent("Contents/Info.plist"))
            guard let info = try PropertyListSerialization.propertyList(from: infoData, format: nil) as? [String: Any],
                  info["CFBundleIdentifier"] as? String == definition.bundleIdentifier,
                  info["CFBundleExecutable"] as? String == executable.lastPathComponent,
                  FileManager.default.isExecutableFile(atPath: executable.path) else {
                throw launchError("The catalog app's installed identity changed.")
            }
            guard matchingApplications().isEmpty else {
                throw launchError("\(definition.name) is already running. Quit it normally before launching with extensions.")
            }
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = false
            configuration.addsToRecentItems = false
            configuration.allowsRunningApplicationSubstitution = false
            configuration.arguments = try launchArguments()
            timeout = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
                Task { @MainActor in
                    self?.finish(error: launchError("LaunchServices did not confirm the app launch within 30 seconds. Any launched app was left running."))
                }
            }
            NSWorkspace.shared.openApplication(at: bundle, configuration: configuration) { [weak self] application, error in
                Task { @MainActor in self?.didOpen(application, error: error) }
            }
        } catch { finish(error: error) }
    }

    private func launchArguments() throws -> [String] {
        let standard = Set(["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"])
        var extras: [String] = []
        for argument in definition.arguments {
            if standard.contains(argument) { continue }
            guard definition.slug == "compass", argument == "--ignoreAdditionalCommandLineFlags",
                  !extras.contains(argument) else {
                throw launchError("The catalog contains an unreviewed LaunchServices argument.")
            }
            extras.append(argument)
        }
        return ["--remote-debugging-port=\(port)", "--remote-debugging-address=127.0.0.1"] + extras
    }

    private func matchingApplications() -> [NSRunningApplication] {
        // A conflicting identifier at another path is also refused; the utility
        // never substitutes, activates, or terminates that existing application.
        NSWorkspace.shared.runningApplications.filter {
            !$0.isTerminated && ($0.bundleIdentifier == definition.bundleIdentifier ||
                $0.bundleURL.map { canonical($0).path == definition.bundlePath } == true)
        }
    }

    private func didOpen(_ app: NSRunningApplication?, error: Error?) {
        guard !finished else { return }
        if let error { finish(error: error); return }
        guard let app, app.processIdentifier > 0, !app.isTerminated,
              app.bundleIdentifier == definition.bundleIdentifier,
              app.bundleURL.map({ canonical($0).path }) == definition.bundlePath,
              app.executableURL.map({ canonical($0).path }) == definition.executable else {
            finish(error: launchError("LaunchServices returned an unexpected app identity. No app was terminated."))
            return
        }
        let current = matchingApplications()
        guard current.count == 1, current[0].processIdentifier == app.processIdentifier else {
            finish(error: launchError("Another matching app appeared during launch. No app was terminated."))
            return
        }
        do {
            // This is callback metadata, not a kernel ownership assertion. The
            // broker must verify PID/start time/UID and its loopback listener.
            let data = try JSONSerialization.data(withJSONObject: [
                "pid": app.processIdentifier, "executable": definition.executable
            ], options: [.sortedKeys])
            FileHandle.standardOutput.write(data + Data([0x0a]))
            finish(error: nil)
        } catch { finish(error: error) }
    }

    private func finish(error: Error?) {
        guard !finished else { return }
        finished = true
        timeout?.invalidate()
        timeout = nil
        if let error {
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            Darwin.exit(EXIT_FAILURE)
        }
        Darwin.exit(EXIT_SUCCESS)
    }
}

@main
private struct CatalogLaunchMain {
    @MainActor
    static func main() {
        do {
            let options = try LaunchOptions(Array(CommandLine.arguments.dropFirst()))
            guard let definition = try definitions().first(where: { $0.slug == options.slug }),
                  definition.transport == "launchservices-tcp" else {
                throw launchError("Choose a catalog app with the LaunchServices TCP transport.")
            }
            let app = NSApplication.shared
            let delegate = LaunchDelegate(definition: definition, port: options.port)
            app.delegate = delegate
            app.setActivationPolicy(.prohibited)
            app.run()
            withExtendedLifetime(delegate) {}
        } catch {
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            Darwin.exit(EXIT_FAILURE)
        }
    }
}
