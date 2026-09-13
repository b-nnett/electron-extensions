import Foundation
import XCTest
@testable import ExtensionsAnywhere

@MainActor
final class RuntimeUpgradeCoordinatorTests: XCTestCase {
    private enum Failure: Error { case rebuild }
    private var app: InstalledApp {
        InstalledApp(id: ElectronLaunchProfile.fixtureURL.path, name: "Style Lab",
                     bundleIdentifier: ElectronLaunchProfile.fixtureKey, url: ElectronLaunchProfile.fixtureURL)
    }

    @MainActor
    private final class State {
        static let helperURL = URL(fileURLWithPath: "/RuntimeUpgradeCoordinatorTests/Style Lab Launcher.app")
        let original = Data("original library bytes\n".utf8)
        var bytes: Data?
        var processes: [AppRestartProcess]
        var events: [String] = []
        var prompts = 0
        var time: TimeInterval = 0
        var accepted = true
        var allowQuit = true
        var onConfirm: (() -> Void)?
        var onTerminate: (() -> Void)?
        var onPrepare: ((Bool) throws -> Void)?

        init(app: InstalledApp) {
            bytes = original
            processes = [
                .init(processIdentifier: 101, bundleIdentifier: app.bundleIdentifier, bundleURL: app.url,
                      launchDate: Date(timeIntervalSince1970: 1000)),
                .init(processIdentifier: 202, bundleIdentifier: "dev.extensionsanywhere.launcher.stylelab",
                      bundleURL: Self.helperURL, launchDate: Date(timeIntervalSince1970: 900))
            ]
        }

        var coordinator: RuntimeUpgradeCoordinator {
            RuntimeUpgradeCoordinator(confirmRestart: { _ in
                self.prompts += 1
                self.onConfirm?()
                return self.accepted
            }, restartEnvironment: .init(runningProcesses: { self.processes }, terminate: { process in
                self.events.append("quit:\(process.processIdentifier)")
                guard self.allowQuit else { return false }
                self.processes.removeAll { $0 == process }
                self.onTerminate?()
                return true
            }, now: { self.time }, sleep: { self.time += $0 }, helperURL: { _ in Self.helperURL }))
        }

        func run(app: InstalledApp, commitError: Error? = nil) async throws -> Bool {
            try await coordinator.run(app: app, helperURL: Self.helperURL, originalLibrary: original,
                readLibrary: { self.bytes }, prepare: { afterShutdown in
                    self.events.append(afterShutdown ? "rebuild" : "preflight")
                    XCTAssertEqual(self.bytes, self.original)
                    if afterShutdown { XCTAssertTrue(self.processes.isEmpty) }
                    try self.onPrepare?(afterShutdown)
                }, commit: {
                    self.events.append("commit")
                    XCTAssertEqual(self.bytes, self.original)
                    if let commitError { throw commitError }
                    self.bytes = Data("committed captured intent".utf8)
                }, open: { self.events.append("open") })
        }
    }

    private func expectError<E: Error & Equatable>(_ expected: E,
        operation: () async throws -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        do { _ = try await operation(); XCTFail("Expected \(expected)", file: file, line: line) }
        catch { XCTAssertEqual(error as? E, expected, file: file, line: line) }
    }

    func testCancelPreservesOriginalBytesAndRunningProcessesWithoutPreparation() async throws {
        let state = State(app: app), processes = stateProcesses(app)
        state.accepted = false
        let committed = try await state.run(app: app)
        XCTAssertFalse(committed)
        XCTAssertEqual(state.prompts, 1)
        XCTAssertEqual(state.bytes, state.original)
        XCTAssertEqual(state.processes, processes)
        XCTAssertTrue(state.events.isEmpty)
    }

    private func stateProcesses(_ app: InstalledApp) -> [AppRestartProcess] { State(app: app).processes }

    func testQuitRefusalPreservesOriginalBytesAndNeverRebuildsOrCommits() async {
        let state = State(app: app)
        state.allowQuit = false
        await expectError(AppRestartError.quitDeclined) { try await state.run(app: app) }
        XCTAssertEqual(state.bytes, state.original)
        XCTAssertEqual(state.events, ["preflight", "quit:101"])
        XCTAssertEqual(state.processes.count, 2)
    }

    func testLibraryChangeWhilePromptIsOpenPreventsQuit() async {
        let state = State(app: app), external = Data("external change".utf8)
        state.onConfirm = { state.bytes = external }
        await expectError(RuntimeUpgradeError.libraryChanged) { try await state.run(app: app) }
        XCTAssertEqual(state.bytes, external)
        XCTAssertTrue(state.events.isEmpty)
        XCTAssertEqual(state.processes.count, 2)
    }

    func testLibraryChangeDuringPreflightPreventsQuit() async {
        let state = State(app: app), external = Data("external change".utf8)
        state.onPrepare = { _ in state.bytes = external }
        await expectError(RuntimeUpgradeError.libraryChanged) { try await state.run(app: app) }
        XCTAssertEqual(state.bytes, external)
        XCTAssertEqual(state.events, ["preflight"])
        XCTAssertEqual(state.processes.count, 2)
    }

    func testLibraryChangeDuringShutdownPreventsRebuildCommitAndOpen() async {
        let state = State(app: app), external = Data("external change".utf8)
        state.onTerminate = { state.bytes = external }
        await expectError(RuntimeUpgradeError.libraryChanged) { try await state.run(app: app) }
        XCTAssertEqual(state.bytes, external)
        XCTAssertEqual(state.events, ["preflight", "quit:101", "quit:202"])
    }

    func testRebuildFailureDoesNotCommitOrReopen() async {
        let state = State(app: app)
        state.onPrepare = { if $0 { throw Failure.rebuild } }
        do { _ = try await state.run(app: app); XCTFail("Expected rebuild failure") }
        catch { XCTAssertTrue(error is Failure) }
        XCTAssertEqual(state.bytes, state.original)
        XCTAssertEqual(state.events, ["preflight", "quit:101", "quit:202", "rebuild"])
    }

    func testSuccessfulRestartRebuildsBeforeCapturedIntentCommitAndOpen() async throws {
        let state = State(app: app)
        let committed = try await state.run(app: app)
        XCTAssertTrue(committed)
        XCTAssertEqual(state.prompts, 1)
        XCTAssertEqual(state.events, ["preflight", "quit:101", "quit:202", "rebuild", "commit", "open"])
        XCTAssertEqual(state.bytes, Data("committed captured intent".utf8))
    }

    func testLibraryChangeDuringRebuildPreventsCommitAndOpen() async {
        let state = State(app: app), external = Data("external change".utf8)
        state.onPrepare = { if $0 { state.bytes = external } }
        await expectError(RuntimeUpgradeError.libraryChanged) { try await state.run(app: app) }
        XCTAssertEqual(state.bytes, external)
        XCTAssertEqual(state.events, ["preflight", "quit:101", "quit:202", "rebuild"])
    }

    func testRetryFailureDoesNotRecursivelyPromptOrSaveOrOpen() async {
        let state = State(app: app)
        do {
            _ = try await state.run(app: app, commitError: ElectronLaunchError.runtimeUpgradeRequired("Style Lab"))
            XCTFail("Expected retry error")
        } catch {
            guard let error = error as? ElectronLaunchError, case .runtimeUpgradeRequired = error else {
                return XCTFail("Wrong retry error: \(error)")
            }
        }
        XCTAssertEqual(state.prompts, 1)
        XCTAssertEqual(state.bytes, state.original)
        XCTAssertEqual(state.events, ["preflight", "quit:101", "quit:202", "rebuild", "commit"])
    }

    func testUnidentifiedOrReplacedTargetCannotBeApprovedForRestart() async {
        let state = State(app: app)
        state.processes = [.init(processIdentifier: 101, bundleIdentifier: app.bundleIdentifier,
                                  bundleURL: URL(fileURLWithPath: "/Other.app"), launchDate: Date())]
        await expectError(RuntimeUpgradeError.missingRunningApp) { try await state.run(app: app) }
        XCTAssertEqual(state.prompts, 0)
        XCTAssertTrue(state.events.isEmpty)
        XCTAssertEqual(state.bytes, state.original)
    }
}
