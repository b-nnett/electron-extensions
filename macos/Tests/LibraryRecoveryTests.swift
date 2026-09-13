import Foundation
import XCTest
@testable import ExtensionsAnywhere

@MainActor
final class LibraryRecoveryTests: XCTestCase {
    private func withDirectory(_ body: (URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("LibraryRecoveryTests-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root)
    }

    private func fixture(at file: URL, name: String = "First") throws -> ExtensionLibrary {
        try ExtensionLibrary().adding(
            source: ImportedExtensionSource(fileName: "style.css", type: .css, text: "button { color: green; }"),
            appKey: "test.recovery.\(name)", name: name, description: "Saved source \(name)", to: file)
    }

    private func permissions(_ file: URL) throws -> Int {
        try XCTUnwrap(FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber).intValue
    }

    func testCommittedMutationBacksUpExactPreviousBytesPrivatelyWithoutStagingSidecars() throws {
        try withDirectory { root in
            let file = root.appendingPathComponent("library.json")
            let first = try fixture(at: file)
            let original = try Data(contentsOf: file)
            let backup = ExtensionLibrary.backupURL(for: file)
            XCTAssertFalse(FileManager.default.fileExists(atPath: backup.path))
            let record = try XCTUnwrap(first.records.first)
            let disabled = try first.settingEnabled(false, for: record.id, appKey: record.appKey, to: file)
            XCTAssertEqual(try Data(contentsOf: backup), original)
            XCTAssertFalse(try ExtensionLibrary.load(from: file).records[0].isEnabled)
            XCTAssertEqual(try permissions(file), 0o600)
            XCTAssertEqual(try permissions(backup), 0o600)

            let staged = root.appendingPathComponent("extension-change-\(UUID().uuidString).json")
            try disabled.save(to: staged)
            XCTAssertFalse(FileManager.default.fileExists(atPath: ExtensionLibrary.backupURL(for: staged).path))
            XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: root.path).contains { $0.hasPrefix(".ea-library-") })
        }
    }

    func testCorruptAndUnsupportedCurrentNeverOverwriteGoodBackupOrCurrent() throws {
        try withDirectory { root in
            let file = root.appendingPathComponent("library.json")
            let library = try fixture(at: file)
            let good = try Data(contentsOf: file)
            let backup = ExtensionLibrary.backupURL(for: file)
            try good.write(to: backup)
            for damaged in [Data("{damaged".utf8), Data(#"{"schemaVersion":2,"records":[],"logs":[]}"#.utf8)] {
                try damaged.write(to: file)
                XCTAssertThrowsError(try library.save(to: file))
                XCTAssertEqual(try Data(contentsOf: file), damaged)
                XCTAssertEqual(try Data(contentsOf: backup), good)
            }
            XCTAssertNoThrow(try ExtensionLibrary.decode(Data(#"{"records":[],"logs":[]}"#.utf8)))
            XCTAssertThrowsError(try ExtensionLibrary.decode(Data(#"{"records":[],"logs":[],"newSchemaField":true}"#.utf8)))
        }
    }

    func testSaveRejectsChangedReviewedSnapshotBeforeTouchingCurrentOrLastGood() throws {
        try withDirectory { root in
            let file = root.appendingPathComponent("library.json")
            let first = try fixture(at: file)
            let reviewed = try XCTUnwrap(ExtensionLibrary.readData(from: file))
            let current = try first.adding(source: .init(fileName: "second.css", type: .css, text: "button {}"),
                appKey: "test.external", name: "External addition", description: "Preserve me", to: file)
            let newer = try XCTUnwrap(ExtensionLibrary.readData(from: file))
            let backup = ExtensionLibrary.backupURL(for: file)
            let lastGood = try Data(contentsOf: backup)
            XCTAssertNotEqual(newer, reviewed)
            for expected in [reviewed, nil] as [Data?] {
                XCTAssertThrowsError(try first.save(to: file, expectedOriginal: expected, checkExpected: true)) { error in
                    guard let error = error as? ExtensionLibraryError, case .changedDuringSave = error else {
                        return XCTFail("Expected stale snapshot refusal, got \(error)")
                    }
                }
                XCTAssertEqual(try Data(contentsOf: file), newer)
                XCTAssertEqual(try Data(contentsOf: backup), lastGood)
            }
            XCTAssertNoThrow(try current.save(to: file, expectedOriginal: newer, checkExpected: true))
            XCTAssertEqual(try Data(contentsOf: backup), lastGood)
            let fresh = root.appendingPathComponent("new.json")
            XCTAssertNoThrow(try first.save(to: fresh, expectedOriginal: nil, checkExpected: true))
            XCTAssertEqual(try ExtensionLibrary.load(from: fresh).records, first.records)
        }
    }

    func testRestorePreservesDamagedOriginalAndEverySourceWithAllRecordsDisabled() throws {
        try withDirectory { root in
            let file = root.appendingPathComponent("library.json")
            let source = root.appendingPathComponent("export.json")
            let first = try fixture(at: source)
            let originalLibrary = try first.adding(
                source: ImportedExtensionSource(fileName: "behavior.js", type: .js, text: "console.log('saved only');"),
                appKey: "test.recovery.other", name: "Other", description: "Unrelated saved source", to: source)
            let backup = ExtensionLibrary.backupURL(for: file)
            let backupBytes = try Data(contentsOf: source)
            try backupBytes.write(to: backup)
            let damaged = Data("{damaged original".utf8)
            try damaged.write(to: file)
            let service = LibraryRecovery(storageURL: file, requireNoActiveSessions: {})
            let plan = try service.prepareRestore(from: source)
            let result = try service.restore(plan)

            let saved = try ExtensionLibrary.load(from: file)
            XCTAssertEqual(saved.records.map(\.id), originalLibrary.records.map(\.id))
            XCTAssertEqual(saved.records.map(\.sourceText), originalLibrary.records.map(\.sourceText))
            XCTAssertEqual(saved.records.map(\.appKey), originalLibrary.records.map(\.appKey))
            XCTAssertEqual(saved.records.map(\.name), originalLibrary.records.map(\.name))
            XCTAssertTrue(saved.records.allSatisfy { !$0.isEnabled })
            XCTAssertEqual(result.recordCount, 2)
            let archive = try XCTUnwrap(result.preservedOriginal)
            XCTAssertEqual(try Data(contentsOf: archive), damaged)
            XCTAssertEqual(try Data(contentsOf: backup), backupBytes)
            XCTAssertEqual(try Data(contentsOf: source), backupBytes)
            XCTAssertEqual(try permissions(archive), 0o600)
            XCTAssertEqual(try permissions(file), 0o600)
            XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: root.path)),
                ["library.json", "library.last-good.json", "export.json", "export.last-good.json", "Recovery Backups"])
        }
    }

    func testRestoreRefusesStalePlanWithoutOverwritingNewCurrentOrMakingArchive() throws {
        try withDirectory { root in
            let file = root.appendingPathComponent("library.json")
            let library = try fixture(at: file)
            let source = root.appendingPathComponent("export.json")
            _ = try fixture(at: source, name: "Replacement")
            let service = LibraryRecovery(storageURL: file, requireNoActiveSessions: {})
            let plan = try service.prepareRestore(from: source)
            let record = try XCTUnwrap(library.records.first)
            _ = try library.settingEnabled(false, for: record.id, appKey: record.appKey, to: file)
            let changed = try Data(contentsOf: file)
            XCTAssertThrowsError(try service.restore(plan))
            XCTAssertEqual(try Data(contentsOf: file), changed)
            XCTAssertFalse(FileManager.default.fileExists(atPath: service.recoveryDirectory.path))
        }
    }

    func testSessionBecomingActiveAtFinalCheckPreservesSelectedLastGoodBackup() throws {
        try withDirectory { root in
            let file = root.appendingPathComponent("library.json")
            _ = try fixture(at: file, name: "Current")
            let original = try Data(contentsOf: file)
            let backup = ExtensionLibrary.backupURL(for: file)
            _ = try fixture(at: backup, name: "LastGood")
            let backupBytes = try Data(contentsOf: backup)
            var checks = 0
            let service = LibraryRecovery(storageURL: file, requireNoActiveSessions: {
                checks += 1
                if checks == 3 { throw LibraryRecoveryError.activeSessions }
            })
            let plan = try service.prepareRestore(from: backup)
            XCTAssertThrowsError(try service.restore(plan))
            XCTAssertEqual(checks, 3)
            XCTAssertEqual(try Data(contentsOf: file), original)
            XCTAssertEqual(try Data(contentsOf: backup), backupBytes)
            let archives = try FileManager.default.contentsOfDirectory(at: service.recoveryDirectory, includingPropertiesForKeys: nil)
            XCTAssertEqual(archives.count, 1)
            XCTAssertEqual(try Data(contentsOf: XCTUnwrap(archives.first)), original)
        }
    }

    func testActiveGuardAndInvalidBackupRefuseBeforeAnyRestoreWrite() throws {
        try withDirectory { root in
            let file = root.appendingPathComponent("library.json")
            _ = try fixture(at: file)
            let original = try Data(contentsOf: file)
            let active = LibraryRecovery(storageURL: file, requireNoActiveSessions: { throw LibraryRecoveryError.activeSessions })
            XCTAssertThrowsError(try active.prepareRestore(from: file))
            let source = root.appendingPathComponent("bad.json")
            try Data(#"{"schemaVersion":2,"records":[],"logs":[]}"#.utf8).write(to: source)
            let service = LibraryRecovery(storageURL: file, requireNoActiveSessions: {})
            XCTAssertThrowsError(try service.prepareRestore(from: source))
            XCTAssertEqual(try Data(contentsOf: file), original)
            XCTAssertFalse(FileManager.default.fileExists(atPath: service.recoveryDirectory.path))
        }
    }

    func testExportPreservesExactValidBytesEnabledStateAndReservedFiles() throws {
        try withDirectory { root in
            let file = root.appendingPathComponent("library.json")
            _ = try fixture(at: file)
            let original = try Data(contentsOf: file)
            let service = LibraryRecovery(storageURL: file, requireNoActiveSessions: { throw LibraryRecoveryError.activeSessions })
            let exported = root.appendingPathComponent("chosen.json")
            try service.export(to: exported)
            XCTAssertEqual(try Data(contentsOf: exported), original)
            XCTAssertTrue(try ExtensionLibrary.load(from: exported).records[0].isEnabled)
            XCTAssertEqual(try permissions(exported), 0o600)
            XCTAssertThrowsError(try service.export(to: file))
            XCTAssertThrowsError(try service.export(to: service.backupURL))
            XCTAssertEqual(try Data(contentsOf: file), original)
        }
    }

    func testWriterRejectsLinkedFilesAndResolvedAppBundleDirectoryWithoutChangingBytes() throws {
        try withDirectory { root in
            let bytes = Data("preserve original".utf8)
            let target = root.appendingPathComponent("target.json")
            try bytes.write(to: target)
            let symbolic = root.appendingPathComponent("symbolic.json")
            try FileManager.default.createSymbolicLink(at: symbolic, withDestinationURL: target)
            XCTAssertThrowsError(try LibraryRecoveryFiles.write(Data("replacement".utf8), to: symbolic))
            let hard = root.appendingPathComponent("hard.json")
            try FileManager.default.linkItem(at: target, to: hard)
            XCTAssertThrowsError(try LibraryRecoveryFiles.write(Data("replacement".utf8), to: hard))
            XCTAssertEqual(try Data(contentsOf: target), bytes)

            let bundle = root.appendingPathComponent("OwnedTest.app/Contents", isDirectory: true)
            try FileManager.default.createDirectory(at: bundle, withIntermediateDirectories: true)
            let inside = bundle.appendingPathComponent("library.json")
            try bytes.write(to: inside)
            let alias = root.appendingPathComponent("outside", isDirectory: true)
            try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: bundle)
            XCTAssertThrowsError(try LibraryRecoveryFiles.write(Data("replacement".utf8), to: inside))
            XCTAssertThrowsError(try LibraryRecoveryFiles.write(Data("replacement".utf8), to: alias.appendingPathComponent("library.json")))
            XCTAssertEqual(try Data(contentsOf: inside), bytes)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: bundle.path), ["library.json"])
        }
    }

    func testOversizedBackupIsRefusedWithoutReadingAnUnboundedFile() throws {
        try withDirectory { root in
            let file = root.appendingPathComponent("library.json")
            _ = try fixture(at: file)
            let original = try Data(contentsOf: file)
            let source = root.appendingPathComponent("oversized.json")
            XCTAssertTrue(FileManager.default.createFile(atPath: source.path, contents: nil))
            let handle = try FileHandle(forWritingTo: source)
            try handle.truncate(atOffset: UInt64(ExtensionLibrary.maximumBytes + 1))
            try handle.close()
            let service = LibraryRecovery(storageURL: file, requireNoActiveSessions: {})
            XCTAssertThrowsError(try service.prepareRestore(from: source))
            XCTAssertEqual(try Data(contentsOf: file), original)
            XCTAssertFalse(FileManager.default.fileExists(atPath: service.recoveryDirectory.path))
        }
    }

    func testRecordedSessionGuardAcceptsOnlyConfirmedAbsentBrokerAndNamesAmbiguousEvidence() throws {
        try withDirectory { root in
            let launchers = root.appendingPathComponent("Launchers")
            let session = launchers.appendingPathComponent(String(repeating: "a", count: 64))
                .appendingPathComponent("Sessions/\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: session, withIntermediateDirectories: true)
            let status = session.appendingPathComponent("status.json")
            try Data(#"{"brokerPid":12345,"phase":"stopped"}"#.utf8).write(to: status)
            var observed: [Int32] = []
            XCTAssertNoThrow(try LibraryRecoverySessionGuard.checkRecordedSessions(in: launchers, observe: { observed.append($0); return .absent }))
            XCTAssertEqual(observed, [12345])
            for observation in [LibraryRecoverySessionGuard.ProcessObservation.running, .unknown] {
                XCTAssertThrowsError(try LibraryRecoverySessionGuard.checkRecordedSessions(in: launchers, observe: { _ in observation })) { error in
                    XCTAssertTrue(error.localizedDescription.contains(session.path))
                }
            }
            for malformed in [#"{"brokerPid":true}"#, #"{"brokerPid":-1}"#, #"{"phase":"stopped"}"#] {
                try Data(malformed.utf8).write(to: status)
                XCTAssertThrowsError(try LibraryRecoverySessionGuard.checkRecordedSessions(in: launchers, observe: { _ in .absent }))
            }
            try FileManager.default.removeItem(at: status)
            XCTAssertThrowsError(try LibraryRecoverySessionGuard.checkRecordedSessions(in: launchers, observe: { _ in .absent }))
            try Data(#"{"brokerPid":12345}"#.utf8).write(to: status)
            let outside = root.appendingPathComponent("outside-session")
            try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
            try Data(#"{"brokerPid":54321}"#.utf8).write(to: outside.appendingPathComponent("status.json"))
            let linked = session.deletingLastPathComponent().appendingPathComponent(UUID().uuidString)
            try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: outside)
            XCTAssertThrowsError(try LibraryRecoverySessionGuard.checkRecordedSessions(in: launchers, observe: { _ in .absent }))
            XCTAssertEqual(try Data(contentsOf: outside.appendingPathComponent("status.json")), Data(#"{"brokerPid":54321}"#.utf8))
            try FileManager.default.removeItem(at: linked)
            XCTAssertNoThrow(try LibraryRecoverySessionGuard.checkRecordedSessions(in: launchers, observe: { _ in .absent }))
            let ancestorLink = root.appendingPathComponent("custom-ancestor")
            try FileManager.default.createSymbolicLink(at: ancestorLink, withDestinationURL: root)
            XCTAssertThrowsError(try LibraryRecoverySessionGuard.checkRecordedSessions(in: ancestorLink.appendingPathComponent("Launchers"), observe: { _ in .absent }))
        }
    }
}
