import AppKit
import Foundation
import Observation

/// A saved library identity, not an installation or a launch target.
struct UnavailableApp: Identifiable, Equatable {
    let appKey: String
    let name: String
    var id: String { "unavailable:\(appKey)" }
}

@MainActor
@Observable
final class AppLibraryStore {
    var selection: InstalledApp.ID?
    private(set) var yourApps: [InstalledApp] = []
    private(set) var unavailableApps: [UnavailableApp] = []
    private(set) var otherApps: [InstalledApp] = []
    private(set) var icons: [InstalledApp.ID: NSImage] = [:]
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private var installedApps: [InstalledApp] = []
    private var legacyAssignments = ExtensionAssignments()
    private var extensionAppKeys: Set<String> = []
    private var knownAppNames: [String: String] = [:]
    private var hasScannedApps = false

    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var iconTask: Task<Void, Never>?
    @ObservationIgnored private var iconGeneration = UUID()
    @ObservationIgnored private var iconIdentities: [InstalledApp.ID: IconRequest] = [:]
    @ObservationIgnored private let scan: @Sendable () throws -> [InstalledApp]
    @ObservationIgnored private let loadAssignments: @Sendable () throws -> ExtensionAssignments
    @ObservationIgnored private let iconLoader: AppIconLoader

    private struct IconRequest: Equatable, Sendable {
        let id: InstalledApp.ID
        let path: String
        let bundleIdentifier: String?

        init(_ app: InstalledApp) {
            id = app.id
            path = app.url.path
            bundleIdentifier = app.bundleIdentifier
        }
    }

    init(
        scan: @escaping @Sendable () throws -> [InstalledApp] = { try ElectronAppDiscovery.scan() },
        loadAssignments: @escaping @Sendable () throws -> ExtensionAssignments = { try ExtensionAssignments.load() },
        iconLoader: AppIconLoader = AppIconLoader()
    ) {
        self.scan = scan
        self.loadAssignments = loadAssignments
        self.iconLoader = iconLoader
    }

    var selectedApp: InstalledApp? {
        installedApps.first { $0.id == selection }
    }

    var selectedUnavailableApp: UnavailableApp? {
        unavailableApps.first { $0.id == selection }
    }

    func setExtensionAppKeys(_ keys: Set<String>) {
        extensionAppKeys = keys
        regroup()
    }

    private func regroup() {
        yourApps = installedApps.filter {
            extensionAppKeys.contains($0.bundleIdentifier ?? $0.id) || legacyAssignments.hasExtensions(for: $0)
        }
        let configured = Set(yourApps.map(\.id))
        otherApps = installedApps.filter { !configured.contains($0.id) }
        let installedKeys = Set(installedApps.map(ExtensionLibrary.appKey(for:)))
        unavailableApps = hasScannedApps ? extensionAppKeys.subtracting(installedKeys).map {
            UnavailableApp(appKey: $0, name: knownAppNames[$0] ?? $0)
        }.sorted {
            let order = $0.name.localizedStandardCompare($1.name)
            return order == .orderedSame ? $0.appKey < $1.appKey : order == .orderedAscending
        } : []
        if let selection, !installedApps.contains(where: { $0.id == selection }),
           !unavailableApps.contains(where: { $0.id == selection }) {
            self.selection = nil
        }
    }

    func refresh() {
        guard refreshTask == nil else { return }
        isLoading = true
        iconTask?.cancel()
        iconGeneration = UUID()
        let generation = iconGeneration

        refreshTask = Task {
            defer {
                isLoading = false
                refreshTask = nil
            }

            do {
                let scan = self.scan, loadAssignments = self.loadAssignments
                let (apps, assignments, assignmentError) = try await Task.detached(priority: .userInitiated) {
                    let apps = try scan()
                    do {
                        return (apps, try loadAssignments(), Optional<String>.none)
                    } catch {
                        return (
                            apps,
                            ExtensionAssignments(byBundleIdentifier: [:]),
                            Optional("Couldn't read your extension assignments.")
                        )
                    }
                }.value

                let selectedKey = selectedApp.map(ExtensionLibrary.appKey(for:)) ?? selectedUnavailableApp?.appKey
                installedApps = apps
                hasScannedApps = true
                for app in apps { knownAppNames[ExtensionLibrary.appKey(for: app)] = app.name }
                legacyAssignments = assignments
                regroup()
                if let selectedKey, selectedApp.map(ExtensionLibrary.appKey(for:)) != selectedKey {
                    selection = apps.first { ExtensionLibrary.appKey(for: $0) == selectedKey }?.id
                        ?? unavailableApps.first { $0.appKey == selectedKey }?.id
                }
                errorMessage = assignmentError

                let requests = Dictionary(uniqueKeysWithValues: apps.map { ($0.id, IconRequest($0)) })
                icons = icons.filter { iconIdentities[$0.key] == requests[$0.key] }
                iconIdentities = requests

                // Rows and grouping are ready even if an icon read is slow.
                loadMissingIcons(apps.map(IconRequest.init), generation: generation)
            } catch {
                errorMessage = "Couldn't scan Applications. Press ⌘R to try again."
            }
        }
    }

    private func loadMissingIcons(_ requests: [IconRequest], generation: UUID) {
        let missing = requests.filter { icons[$0.id] == nil }
        let loader = iconLoader
        iconTask = Task { [weak self] in
            for request in missing {
                guard !Task.isCancelled else { return }
                let data = await loader.data(for: request.path)
                guard !Task.isCancelled else { return }
                if let data { self?.acceptIcon(data, request: request, generation: generation) }
            }
            if self?.iconGeneration == generation { self?.iconTask = nil }
        }
    }

    private func acceptIcon(_ data: Data, request: IconRequest, generation: UUID) {
        guard iconGeneration == generation,
              iconIdentities[request.id] == request,
              let image = NSImage(data: data) else { return }
        icons[request.id] = image
    }
}
