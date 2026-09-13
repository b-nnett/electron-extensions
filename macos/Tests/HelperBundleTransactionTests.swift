import Foundation
import RuntimeCatalog
import XCTest
@testable import ExtensionsAnywhere

@MainActor
final class HelperBundleTransactionTests: XCTestCase {
    private enum InjectedFailure: Error { case interruption, signing }
    private let identifier = "dev.extensionsanywhere.test.helper-transaction"
    private let manager = FileManager.default

    private func withDirectory(_ body: (URL, URL) throws -> Void) throws {
        let root = manager.temporaryDirectory.appendingPathComponent("HelperTransactionTests-\(UUID().uuidString)").resolvingSymlinksInPath()
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: root) }
        try body(root, root.appendingPathComponent("Example Launcher.app"))
    }

    private func codesign(_ app: URL, sign: Bool = false) throws {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        task.arguments = (sign ? ["--force", "--sign", "-"] : ["--verify", "--strict"]) + [app.path]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try task.run()
        task.waitUntilExit()
        guard task.terminationStatus == 0 else { throw InjectedFailure.signing }
    }

    /// Only a temporary copy of the OS true executable is signed. It is never
    /// launched, registered with LaunchServices, or put in the real Dock.
    private func build(_ app: URL, version: String) throws {
        let contents = app.appendingPathComponent("Contents")
        try manager.createDirectory(at: contents.appendingPathComponent("MacOS"), withIntermediateDirectories: true)
        try manager.createDirectory(at: contents.appendingPathComponent("Resources/Runtime"), withIntermediateDirectories: true)
        try manager.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"), to: contents.appendingPathComponent("MacOS/ExtensionLauncher"))
        let info = ["CFBundleIdentifier": identifier, "CFBundleExecutable": "ExtensionLauncher", "CFBundleName": "Example",
                    "CFBundlePackageType": "APPL", "EALauncherSourceSHA256": version]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
        try Data(version.utf8).write(to: contents.appendingPathComponent("Resources/Runtime/marker.txt"))
        try codesign(app, sign: true)
    }

    private func marker(_ app: URL) throws -> String {
        try String(contentsOf: app.appendingPathComponent("Contents/Resources/Runtime/marker.txt"), encoding: .utf8)
    }

    private func transaction(_ helper: URL) -> HelperBundleTransaction {
        HelperBundleTransaction(installed: helper, identifier: identifier,
                                verify: { try self.codesign($0) }, isActive: { false })
    }

    func testSignedContentsSwapPreservesBundleInodeAndFinderAlias() throws {
        try withDirectory { root, app in
            try build(app, version: "old")
            let inode = try manager.attributesOfItem(atPath: app.path)[.systemFileNumber] as? NSNumber
            let alias = root.appendingPathComponent("Example.app")
            try RuntimeLauncherAlias.prepare(at: alias, target: app)
            let aliasBytes = try Data(contentsOf: alias)
            XCTAssertEqual(try transaction(app).install { try build($0, version: "new") }, .complete)
            XCTAssertEqual(try marker(app), "new")
            try codesign(app)
            XCTAssertEqual(try manager.attributesOfItem(atPath: app.path)[.systemFileNumber] as? NSNumber, inode)
            XCTAssertEqual(try Data(contentsOf: alias), aliasBytes)
            XCTAssertEqual(try URL(resolvingAliasFileAt: alias, options: [.withoutUI, .withoutMounting]).standardizedFileURL.resolvingSymlinksInPath().path,
                           app.standardizedFileURL.resolvingSymlinksInPath().path)
            XCTAssertFalse(try transaction(app).hasPendingCommit())
            XCTAssertEqual(Set(try manager.contentsOfDirectory(atPath: root.path)), ["Example Launcher.app", "Example.app"])
        }
    }

    func testEveryInterruptedCommitBoundaryRecoversTheWholeSignedHelper() throws {
        for point in HelperBundleTransaction.Checkpoint.allCases {
            try withDirectory { _, app in
                try build(app, version: "old")
                var update = transaction(app)
                update.checkpoint = { if $0 == point { throw InjectedFailure.interruption } }
                XCTAssertThrowsError(try update.install { try build($0, version: "new") })
                XCTAssertTrue(try update.hasPendingCommit())
                XCTAssertEqual(try marker(app), point == .receiptSaved ? "old" : "new")
                try codesign(app)
                XCTAssertEqual(try transaction(app).recover(), .complete)
                XCTAssertEqual(try marker(app), "new")
                try codesign(app)
                XCTAssertFalse(try update.hasPendingCommit())
            }
        }
    }

    func testInterruptedFirstInstallRecoversWithoutAnInventedPreviousHelper() throws {
        for point in HelperBundleTransaction.Checkpoint.allCases {
            try withDirectory { _, app in
                var update = transaction(app)
                update.checkpoint = { if $0 == point { throw InjectedFailure.interruption } }
                XCTAssertThrowsError(try update.install { try build($0, version: "new") })
                XCTAssertEqual(try transaction(app).recover(), .complete)
                XCTAssertEqual(try marker(app), "new")
                try codesign(app)
            }
        }
    }

    func testBuildOrSigningFailureCannotChangeInstalledHelper() throws {
        try withDirectory { root, app in
            try build(app, version: "old")
            let update = transaction(app)
            XCTAssertThrowsError(try update.install { stage in
                try build(stage, version: "new")
                throw InjectedFailure.signing
            })
            XCTAssertEqual(try marker(app), "old")
            try codesign(app)
            XCTAssertFalse(try update.hasPendingCommit())
            XCTAssertEqual(try manager.contentsOfDirectory(atPath: root.path), ["Example Launcher.app"])
        }
    }

    func testActiveHelperDefersBeforeBuildAndDuringRecovery() throws {
        try withDirectory { _, app in
            try build(app, version: "old")
            var update = transaction(app)
            update.isActive = { true }
            XCTAssertEqual(try update.install { _ in XCTFail("Must not build while active") }, .deferred)
            update.isActive = { false }
            update.checkpoint = { if $0 == .receiptSaved { throw InjectedFailure.interruption } }
            XCTAssertThrowsError(try update.install { try build($0, version: "new") })
            let receipt = try Data(contentsOf: update.receiptURL)
            update.isActive = { true }
            XCTAssertEqual(try update.recover(), .deferred)
            XCTAssertEqual(try marker(app), "old")
            XCTAssertEqual(try Data(contentsOf: update.receiptURL), receipt)
            XCTAssertEqual(try transaction(app).recover(), .complete)
        }
    }

    func testHelperStartingDuringStagingPreventsCommit() throws {
        try withDirectory { root, app in
            try build(app, version: "old")
            var active = false
            var update = transaction(app)
            update.isActive = { active }
            XCTAssertEqual(try update.install { stage in
                try build(stage, version: "new")
                active = true
            }, .deferred)
            XCTAssertEqual(try marker(app), "old")
            XCTAssertFalse(try update.hasPendingCommit())
            XCTAssertEqual(try manager.contentsOfDirectory(atPath: root.path), ["Example Launcher.app"])
        }
    }

    func testUnrecognizedChangedStageAndInstalledContentsArePreserved() throws {
        for changeStage in [false, true] {
            try withDirectory { root, app in
                try build(app, version: "old")
                var update = transaction(app)
                update.checkpoint = { if $0 == .receiptSaved { throw InjectedFailure.interruption } }
                XCTAssertThrowsError(try update.install { try build($0, version: "new") })
                let stage = try XCTUnwrap(manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first { $0.lastPathComponent.hasPrefix(".helper-stage-") })
                let changed = changeStage ? stage : app
                try Data("external change".utf8).write(to: changed.appendingPathComponent("Contents/Resources/Runtime/marker.txt"))
                XCTAssertThrowsError(try transaction(app).recover())
                XCTAssertEqual(try marker(changed), "external change")
                XCTAssertTrue(try update.hasPendingCommit())
                XCTAssertTrue(manager.fileExists(atPath: stage.path))
            }
        }
    }

    func testMatchingMetadataWithInvalidSignatureIsRebuiltAndVerified() throws {
        try withDirectory { _, app in
            try build(app, version: "new")
            let digest = try RuntimeResourceFiles.digest(in: app.appendingPathComponent("Contents/Resources/Runtime"))
            try manager.removeItem(at: app.appendingPathComponent("Contents/_CodeSignature"))
            let launcher = ElectronLauncher()
            XCTAssertFalse(try launcher.helperIsCurrent(app, identifier: identifier, sourceHash: "new", runtimeDigest: digest))
            XCTAssertEqual(try transaction(app).install { try build($0, version: "new") }, .complete)
            XCTAssertTrue(try launcher.helperIsCurrent(app, identifier: identifier, sourceHash: "new", runtimeDigest: digest))
        }
    }

    func testMatchingMetadataWithSignedWrongRuntimeIsRebuilt() throws {
        try withDirectory { _, app in
            try build(app, version: "new")
            let digest = try RuntimeResourceFiles.digest(in: app.appendingPathComponent("Contents/Resources/Runtime"))
            try Data("wrong runtime".utf8).write(to: app.appendingPathComponent("Contents/Resources/Runtime/marker.txt"))
            try codesign(app, sign: true)
            let launcher = ElectronLauncher()
            XCTAssertFalse(try launcher.helperIsCurrent(app, identifier: identifier, sourceHash: "new", runtimeDigest: digest))
            XCTAssertEqual(try transaction(app).install { try build($0, version: "new") }, .complete)
            XCTAssertTrue(try launcher.helperIsCurrent(app, identifier: identifier, sourceHash: "new", runtimeDigest: digest))
        }
    }

    func testMatchingRuntimeWithoutRequiredCapabilityMarkerStillNeedsHelperUpdate() throws {
        try withDirectory { _, app in
            try build(app, version: "new")
            let infoURL = app.appendingPathComponent("Contents/Info.plist")
            var info = try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: infoURL), options: [], format: nil) as? [String: Any])
            let helperIdentifier = "dev.extensionsanywhere.launcher.stylelab"
            info["CFBundleIdentifier"] = helperIdentifier
            try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: infoURL)
            try codesign(app, sign: true)
            let digest = try RuntimeResourceFiles.digest(in: app.appendingPathComponent("Contents/Resources/Runtime"))
            let launcher = ElectronLauncher()
            XCTAssertTrue(try launcher.helperIsCurrent(app, identifier: helperIdentifier, sourceHash: "new", runtimeDigest: digest))
            XCTAssertFalse(try launcher.helperIsCurrent(app, identifier: helperIdentifier, sourceHash: "new", runtimeDigest: digest,
                                                       rendererJavaScriptProfile: "stylelab", rendererJavaScriptTargetIdentifier: "dev.extensionsanywhere.stylelab"))
            info.merge(RuntimeHelperCapabilities.metadata(profile: "stylelab", targetIdentifier: "dev.extensionsanywhere.stylelab")) { _, marker in marker }
            try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: infoURL)
            try codesign(app, sign: true)
            XCTAssertTrue(try launcher.helperIsCurrent(app, identifier: helperIdentifier, sourceHash: "new", runtimeDigest: digest,
                                                      rendererJavaScriptProfile: "stylelab", rendererJavaScriptTargetIdentifier: "dev.extensionsanywhere.stylelab"))
            XCTAssertFalse(try launcher.helperIsCurrent(app, identifier: helperIdentifier, sourceHash: "new", runtimeDigest: digest,
                                                       rendererJavaScriptProfile: "vscode", rendererJavaScriptTargetIdentifier: "com.microsoft.VSCode"))
        }
    }

    func testReceiptCannotRedirectRecoveryToAnotherBundle() throws {
        try withDirectory { root, app in
            try build(app, version: "old")
            var update = transaction(app)
            update.checkpoint = { if $0 == .receiptSaved { throw InjectedFailure.interruption } }
            XCTAssertThrowsError(try update.install { try build($0, version: "new") })
            var receipt = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: update.receiptURL)) as? [String: Any])
            receipt["destination"] = "Other.app"
            let tampered = try JSONSerialization.data(withJSONObject: receipt)
            try tampered.write(to: update.receiptURL)
            XCTAssertThrowsError(try transaction(app).recover())
            XCTAssertEqual(try Data(contentsOf: update.receiptURL), tampered)
            XCTAssertEqual(try marker(app), "old")
            XCTAssertFalse(manager.fileExists(atPath: root.appendingPathComponent("Other.app").path))
        }
    }
}
