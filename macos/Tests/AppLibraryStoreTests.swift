import AppKit
import Foundation
import XCTest
@testable import ExtensionsAnywhere

@MainActor
final class AppLibraryStoreTests: XCTestCase {
    private static let imageData = Data(base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
    )!

    private final class Inputs: @unchecked Sendable {
        private let lock = NSLock()
        let release = DispatchSemaphore(value: 0)
        private var apps: [InstalledApp]
        private var scanCount = 0
        private var paths: [String] = []
        private var completedCount = 0
        private var readOnMain = false
        private let blockedRead: Int?
        private let results: [Data?]

        init(apps: [InstalledApp] = [], blockedRead: Int? = nil, results: [Data?]) {
            self.apps = apps
            self.blockedRead = blockedRead
            self.results = results
        }

        func replaceApps(_ value: [InstalledApp]) { lock.withLock { apps = value } }
        func scan() -> [InstalledApp] { lock.withLock { scanCount += 1; return apps } }
        var scans: Int { lock.withLock { scanCount } }
        var readPaths: [String] { lock.withLock { paths } }
        var completed: Int { lock.withLock { completedCount } }
        var usedMainThread: Bool { lock.withLock { readOnMain } }

        func read(_ path: String) -> Data? {
            let index = lock.withLock {
                paths.append(path)
                readOnMain = readOnMain || Thread.isMainThread
                return paths.count
            }
            if index == blockedRead { _ = release.wait(timeout: .now() + 5) }
            return lock.withLock {
                completedCount += 1
                return index <= results.count ? results[index - 1] : nil
            }
        }
    }

    private func app(path: String = "/Synthetic/Example.app", identifier: String = "test.example") -> InstalledApp {
        InstalledApp(id: "stable-test-id", name: "Example", bundleIdentifier: identifier,
                     url: URL(fileURLWithPath: path))
    }

    private func store(_ input: Inputs) -> AppLibraryStore {
        AppLibraryStore(scan: { input.scan() }, loadAssignments: { ExtensionAssignments() },
                        iconLoader: AppIconLoader(reader: { input.read($0) }))
    }

    private func eventually(_ predicate: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while !predicate(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(predicate(), "Asynchronous condition did not complete", file: file, line: line)
    }

    func testRowsAndGroupingPublishBeforeBlockedIconAndReaderIsOffMain() async throws {
        let app = app()
        let input = Inputs(apps: [app], blockedRead: 1, results: [Self.imageData])
        defer { input.release.signal() }
        let store = store(input)
        store.setExtensionAppKeys(["test.example"])
        store.refresh()

        try await eventually { !store.isLoading && input.readPaths.count == 1 }
        XCTAssertEqual(store.yourApps, [app])
        XCTAssertTrue(store.otherApps.isEmpty)
        XCTAssertTrue(store.icons.isEmpty)
        // Selection remains usable on MainActor while the worker is blocked.
        store.selection = app.id
        XCTAssertEqual(store.selectedApp, app)
        XCTAssertFalse(input.usedMainThread)

        input.release.signal()
        try await eventually { store.icons[app.id] != nil }
    }

    func testDelayedOldGenerationCannotPopulateRefreshedSameIdentityOrMovedPath() async throws {
        let original = app()
        for replacement in [original, app(path: "/Synthetic/Moved.app")] {
            let input = Inputs(apps: [original], blockedRead: 1, results: [Self.imageData, nil])
            defer { input.release.signal() }
            let store = store(input)
            store.refresh()
            try await eventually { !store.isLoading && input.readPaths.count == 1 }

            input.replaceApps([replacement])
            store.refresh()
            try await eventually { !store.isLoading && input.scans == 2 }
            XCTAssertEqual(store.otherApps, [replacement])
            input.release.signal()
            try await eventually { input.completed == 2 }
            // Allow the resumed MainActor task to consume the nil second result.
            try await Task.sleep(for: .milliseconds(20))
            XCTAssertTrue(store.icons.isEmpty)
            XCTAssertEqual(input.readPaths, [original.url.path, replacement.url.path])
        }
    }

    func testCachedIconsAreReusedButChangedIdentityAndRemovedRowsArePruned() async throws {
        let original = app()
        let input = Inputs(apps: [original], results: [Self.imageData, nil])
        let store = store(input)
        store.refresh()
        try await eventually { !store.isLoading && store.icons[original.id] != nil }

        store.refresh()
        try await eventually { !store.isLoading && input.scans == 2 }
        XCTAssertEqual(input.readPaths.count, 1)
        XCTAssertNotNil(store.icons[original.id])

        let changed = app(identifier: "test.different")
        input.replaceApps([changed])
        store.refresh()
        try await eventually { !store.isLoading && input.completed == 2 }
        XCTAssertTrue(store.icons.isEmpty)

        input.replaceApps([])
        store.refresh()
        try await eventually { !store.isLoading && input.scans == 4 }
        XCTAssertTrue(store.otherApps.isEmpty)
        XCTAssertTrue(store.icons.isEmpty)
    }

    func testConcurrentIconRequestsAreSerialized() async throws {
        let input = Inputs(blockedRead: 1, results: [Data([1]), Data([2])])
        defer { input.release.signal() }
        let loader = AppIconLoader(reader: { input.read($0) })
        let first = Task { await loader.data(for: "first") }
        try await eventually { input.readPaths.count == 1 }
        let second = Task { await loader.data(for: "second") }
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(input.readPaths, ["first"])
        input.release.signal()
        let firstData = await first.value, secondData = await second.value
        XCTAssertEqual(firstData, Data([1]))
        XCTAssertEqual(secondData, Data([2]))
        XCTAssertEqual(input.readPaths, ["first", "second"])
        XCTAssertFalse(input.usedMainThread)
    }

    func testSavedAppRemainsSelectableWhenInstallationDisappears() async throws {
        let configured = InstalledApp(id: "/Synthetic/Saved.app", name: "Saved App", bundleIdentifier: "test.saved",
                                      url: URL(fileURLWithPath: "/Synthetic/Saved.app"))
        let unrelated = InstalledApp(id: "/Synthetic/Other.app", name: "Other", bundleIdentifier: "test.other",
                                     url: URL(fileURLWithPath: "/Synthetic/Other.app"))
        let input = Inputs(apps: [configured, unrelated], results: [])
        let store = store(input)
        store.setExtensionAppKeys(["test.saved"])
        store.refresh()
        try await eventually { !store.isLoading && input.scans == 1 }
        store.selection = configured.id

        input.replaceApps([unrelated])
        store.refresh()
        try await eventually { !store.isLoading && input.scans == 2 }

        XCTAssertTrue(store.yourApps.isEmpty)
        XCTAssertEqual(store.otherApps, [unrelated])
        let unavailable = try XCTUnwrap(store.unavailableApps.first)
        XCTAssertEqual(unavailable.appKey, "test.saved")
        XCTAssertEqual(unavailable.name, "Saved App")
        XCTAssertEqual(store.selection, unavailable.id)
        XCTAssertEqual(store.selectedUnavailableApp, unavailable)
        XCTAssertNil(store.selectedApp)
    }

    func testMatchingReinstallationRestoresInstalledRowAndSelection() async throws {
        let input = Inputs(apps: [], results: [])
        let store = store(input)
        store.setExtensionAppKeys(["test.saved", "test.still-missing"])
        store.refresh()
        try await eventually { !store.isLoading && input.scans == 1 }
        let saved = try XCTUnwrap(store.unavailableApps.first { $0.appKey == "test.saved" })
        XCTAssertEqual(saved.name, "test.saved", "An unknown installation name must not be invented")
        store.selection = saved.id

        let wrongIdentity = InstalledApp(id: "/Synthetic/Reinstalled.app", name: "Other identity", bundleIdentifier: "test.other",
                                         url: URL(fileURLWithPath: "/Synthetic/Reinstalled.app"))
        input.replaceApps([wrongIdentity])
        store.refresh()
        try await eventually { !store.isLoading && input.scans == 2 }
        XCTAssertEqual(store.selectedUnavailableApp, saved)
        XCTAssertTrue(store.yourApps.isEmpty)
        XCTAssertEqual(store.otherApps, [wrongIdentity])

        let installed = InstalledApp(id: "/Synthetic/Reinstalled.app", name: "Reinstalled", bundleIdentifier: "test.saved",
                                     url: URL(fileURLWithPath: "/Synthetic/Reinstalled.app"))
        input.replaceApps([installed])
        store.refresh()
        try await eventually { !store.isLoading && input.scans == 3 }

        XCTAssertEqual(store.yourApps, [installed])
        XCTAssertEqual(store.selectedApp, installed)
        XCTAssertNil(store.selectedUnavailableApp)
        XCTAssertEqual(store.selection, installed.id)
        XCTAssertEqual(store.unavailableApps.map(\.appKey), ["test.still-missing"])
    }

    func testRemovingLastSavedRecordPrunesOnlyItsUnavailableRow() async throws {
        let input = Inputs(apps: [], results: [])
        let store = store(input)
        store.setExtensionAppKeys(["test.removed", "test.kept"])
        store.refresh()
        try await eventually { !store.isLoading }
        store.selection = try XCTUnwrap(store.unavailableApps.first { $0.appKey == "test.removed" }).id

        store.setExtensionAppKeys(["test.kept"])

        XCTAssertEqual(store.unavailableApps.map(\.appKey), ["test.kept"])
        XCTAssertNil(store.selection)
        XCTAssertNil(store.selectedApp)
    }
}
