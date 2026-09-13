import Combine
import Foundation
import Sparkle
import SwiftUI

/// Only the manager updates itself. Target apps and their signatures are outside this updater.
@MainActor
final class AppUpdater: ObservableObject {
    @Published private(set) var canCheckForUpdates = false
    @Published private(set) var automaticallyChecksForUpdates = false
    @Published private(set) var automaticallyDownloadsUpdates = false
    @Published private(set) var lastUpdateCheckDate: Date?
    @Published private(set) var startupError: String?
    private let controller: SPUStandardUpdaterController
    private var started = false

    init() {
        controller = SPUStandardUpdaterController(
            startingUpdater: false, updaterDelegate: nil, userDriverDelegate: nil
        )
        controller.updater.publisher(for: \.canCheckForUpdates).assign(to: &$canCheckForUpdates)
        controller.updater.publisher(for: \.automaticallyChecksForUpdates).assign(to: &$automaticallyChecksForUpdates)
        controller.updater.publisher(for: \.automaticallyDownloadsUpdates).assign(to: &$automaticallyDownloadsUpdates)
        controller.updater.publisher(for: \.lastUpdateCheckDate).assign(to: &$lastUpdateCheckDate)
    }

    func start() {
        guard !started else { return }
        do {
            try UpdateConfiguration.validate(Bundle.main.infoDictionary ?? [:])
            // The signed bundle owns the feed; do not inherit obsolete developer overrides.
            controller.updater.clearFeedURLFromUserDefaults()
            try controller.updater.start()
            started = true
        } catch {
            startupError = error.localizedDescription
        }
    }

    func checkForUpdates() {
        guard canCheckForUpdates else { return }
        controller.checkForUpdates(nil)
    }

    func setAutomaticChecks(_ enabled: Bool) { controller.updater.automaticallyChecksForUpdates = enabled }
    func setAutomaticDownloads(_ enabled: Bool) { controller.updater.automaticallyDownloadsUpdates = enabled }
}

enum UpdateConfiguration {
    static func validate(_ info: [String: Any]) throws {
        guard let value = info["SUFeedURL"] as? String,
              let url = URLComponents(string: value), url.scheme == "https",
              let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.fragment == nil, url.query == nil else {
            throw ConfigurationError("This build has no valid HTTPS update feed.")
        }
        guard let publicKey = info["SUPublicEDKey"] as? String,
              let data = Data(base64Encoded: publicKey), data.count == 32,
              data.base64EncodedString() == publicKey else {
            throw ConfigurationError("This build has no valid update signing key.")
        }
        guard info["SUVerifyUpdateBeforeExtraction"] as? Bool == true,
              info["SURequireSignedFeed"] as? Bool == true else {
            throw ConfigurationError("This build does not require signed update feeds and downloads.")
        }
    }

    private struct ConfigurationError: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
}

struct CheckForUpdatesButton: View {
    @ObservedObject var updater: AppUpdater
    var body: some View {
        Button("Check for Updates…", action: updater.checkForUpdates)
            .disabled(!updater.canCheckForUpdates)
    }
}

struct UpdateSettingsSection: View {
    @ObservedObject var updater: AppUpdater
    var body: some View {
        Section("Updates") {
            if let error = updater.startupError {
                Text(error).foregroundStyle(.secondary)
            } else {
                Toggle("Automatically check for updates", isOn: Binding(
                    get: { updater.automaticallyChecksForUpdates }, set: updater.setAutomaticChecks
                ))
                Toggle("Automatically download and install updates", isOn: Binding(
                    get: { updater.automaticallyDownloadsUpdates }, set: updater.setAutomaticDownloads
                ))
                .disabled(!updater.automaticallyChecksForUpdates)
                Text("Updates apply to Extensions Anywhere. Downloaded updates install when it quits.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            CheckForUpdatesButton(updater: updater)
            if let date = updater.lastUpdateCheckDate {
                Text("Last checked: \(date.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
