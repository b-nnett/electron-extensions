import Foundation

/// Small local diagnostic history. Records lifecycle metadata, never extension
/// source, page contents, debugger URLs, or app documents.
@MainActor
final class RuntimeEventJournal {
    struct Event: Codable {
        let timestamp: Date
        let event: String
        let appKey: String
        let bundlePath: String
        let processIdentifier: Int32?
        let processStartedAt: Date?
    }

    static let shared = RuntimeEventJournal()
    static let maximumEvents = 500
    private let url: URL
    private var events: [Event]

    init(url: URL = ExtensionLibrary.defaultURL.deletingLastPathComponent().appendingPathComponent("runtime-events.json")) {
        self.url = url
        if let data = RuntimeSessionFiles.read(url, limit: 512 * 1024),
           let saved = try? JSONDecoder().decode([Event].self, from: data) {
            events = Array(saved.suffix(Self.maximumEvents))
        } else {
            events = []
        }
    }

    func record(_ event: String, app: InstalledApp, processIdentifier: Int32? = nil, processStartedAt: Date? = nil) {
        events.append(Event(timestamp: Date(), event: event, appKey: ExtensionLibrary.appKey(for: app),
                            bundlePath: app.url.path, processIdentifier: processIdentifier, processStartedAt: processStartedAt))
        events = Array(events.suffix(Self.maximumEvents))
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(events)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch {
            // Diagnostics must not prevent a launch or change a user's choice.
        }
    }

    func record(_ event: String, instance: RunningTweakInstance) {
        record(event, app: instance.app, processIdentifier: instance.processIdentifier, processStartedAt: instance.launchDate)
    }
}
