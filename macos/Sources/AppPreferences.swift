import Foundation
import Observation

struct TweakedAppsMenuLayout {
    let directApps: [InstalledApp]
    let mostUsedApps: [InstalledApp]
    let allApps: [InstalledApp]

    var usesSubmenu: Bool { !allApps.isEmpty }
}

@MainActor
@Observable
final class AppPreferences {
    var promptToRestartAppsWithoutExtensions: Bool {
        didSet { defaults.set(promptToRestartAppsWithoutExtensions, forKey: Self.restartPromptKey) }
    }

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let now: () -> Date
    private var usage: [String: AppUsage]

    private static let restartPromptKey = "promptToRestartAppsWithoutExtensions"
    private static let usageKey = "tweakedAppUsage.v1"
    private static let directAppLimit = 5

    private struct AppUsage: Codable {
        var count: Int
        var lastUsed: Date
    }

    init(defaults: UserDefaults = .standard, now: @escaping () -> Date = Date.init) {
        self.defaults = defaults
        self.now = now
        let storedPrompt = defaults.object(forKey: Self.restartPromptKey) as? Bool
        promptToRestartAppsWithoutExtensions = storedPrompt ?? true
        if storedPrompt == nil { defaults.set(true, forKey: Self.restartPromptKey) }
        let storedUsage = defaults.data(forKey: Self.usageKey)
            .flatMap { try? JSONDecoder().decode([String: AppUsage].self, from: $0) } ?? [:]
        usage = storedUsage.filter {
            $0.value.count > 0 && $0.value.lastUsed.timeIntervalSinceReferenceDate.isFinite
        }
    }

    /// Called after an actual app activation, rather than when launch is requested.
    /// InstalledApp.id identifies the installed path, so copies do not share counts.
    func recordUse(of app: InstalledApp) {
        let date = now()
        guard date.timeIntervalSinceReferenceDate.isFinite else { return }
        let previousCount = usage[app.id]?.count ?? 0
        usage[app.id] = AppUsage(
            count: previousCount == Int.max ? Int.max : previousCount + 1,
            lastUsed: date
        )
        if let data = try? JSONEncoder().encode(usage) { defaults.set(data, forKey: Self.usageKey) }
    }

    func mostUsedApps(from apps: [InstalledApp]) -> [InstalledApp] {
        apps.sorted { lhs, rhs in
            let left = usage[lhs.id], right = usage[rhs.id]
            let leftCount = left?.count ?? 0, rightCount = right?.count ?? 0
            if leftCount != rightCount { return leftCount > rightCount }
            let leftDate = left?.lastUsed ?? .distantPast
            let rightDate = right?.lastUsed ?? .distantPast
            if leftDate != rightDate { return leftDate > rightDate }
            return Self.alphabeticallyPrecedes(lhs, rhs)
        }
    }

    func menuLayout(for apps: [InstalledApp]) -> TweakedAppsMenuLayout {
        let alphabetical = apps.sorted(by: Self.alphabeticallyPrecedes)
        guard apps.count > Self.directAppLimit else {
            return TweakedAppsMenuLayout(directApps: alphabetical, mostUsedApps: [], allApps: [])
        }
        return TweakedAppsMenuLayout(
            directApps: [],
            mostUsedApps: Array(mostUsedApps(from: apps).prefix(Self.directAppLimit)),
            allApps: alphabetical
        )
    }

    private static func alphabeticallyPrecedes(_ lhs: InstalledApp, _ rhs: InstalledApp) -> Bool {
        let order = lhs.name.localizedStandardCompare(rhs.name)
        return order == .orderedSame ? lhs.id < rhs.id : order == .orderedAscending
    }
}
