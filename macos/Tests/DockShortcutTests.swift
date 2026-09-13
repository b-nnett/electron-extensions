import Foundation
import XCTest
@testable import ExtensionsAnywhere

@MainActor
final class DockShortcutTests: XCTestCase {
    typealias Tile = DockShortcutEngine.Tile

    @MainActor
    private final class Preferences {
        var pins: [Tile]
        var writes = 0
        var reads = 0
        var persistWrites = true
        var beforeWrite: (() throws -> Void)?
        var beforeRead: (() throws -> Void)?

        init(_ pins: [Tile]) { self.pins = pins }

        var access: DockPreferencesAccess {
            DockPreferencesAccess(read: {
                self.reads += 1
                try self.beforeRead?()
                return self.pins
            }, write: { pins in
                try self.beforeWrite?()
                self.writes += 1
                if self.persistWrites { self.pins = pins }
            }, refresh: {})
        }
    }

    private func withDirectory(_ body: (URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ExtensionsAnywhere-DockTests-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root)
    }

    private func tile(_ url: URL, guid: Int64? = 3_097_887_577, label: String = "Original") -> Tile {
        var result: Tile = [
            "tile-type": "file-tile", "custom-top-level": "preserve",
            "tile-data": [
                "file-data": ["_CFURLString": url.absoluteString, "_CFURLStringType": 15],
                "file-label": label, "bundle-identifier": "test.original", "file-type": 41,
                "book": Data([1, 2, 3]), "file-mod-date": 100, "custom-user-field": ["preserve", 7]
            ]
        ]
        if let guid { result["GUID"] = guid }
        return result
    }

    private func makeApp(_ url: URL, identifier: String? = "test.launcher") throws {
        let contents = url.appendingPathComponent("Contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        var info = ["CFBundleName": "Owned Launcher", "CFBundlePackageType": "APPL"]
        if let identifier { info["CFBundleIdentifier"] = identifier }
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"))
    }

    private func makeAlias(_ url: URL, to target: URL) throws {
        let bookmark = try target.bookmarkData(options: .suitableForBookmarkFile, includingResourceValuesForKeys: nil, relativeTo: nil)
        try URL.writeBookmarkData(bookmark, to: url)
        XCTAssertEqual(try url.resourceValues(forKeys: [.isAliasFileKey]).isAliasFile, true)
    }

    private func receipt(in directory: URL) throws -> (URL, [String: Any]) {
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        let file = try XCTUnwrap(files.only)
        let data = try Data(contentsOf: file)
        XCTAssertEqual(String(data: data.prefix(8), encoding: .ascii), "bplist00")
        let value = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any])
        return (file, value)
    }

    func testPreparedReceiptPrecedesWriteAndInstalledRoundTrip() throws {
        try withDirectory { root in
            let target = root.appendingPathComponent("Original.app")
            let replacement = root.appendingPathComponent("Launcher.app")
            try makeApp(replacement)
            let original = tile(target)
            let directory = root.appendingPathComponent("Receipts")
            let preferences = Preferences([original])
            preferences.beforeWrite = {
                let saved = try self.receipt(in: directory).1
                XCTAssertEqual(saved["state"] as? String, "prepared")
                XCTAssertEqual(saved["originalGUID"] as? Int64, 3_097_887_577)
                XCTAssertTrue(NSDictionary(dictionary: try XCTUnwrap(saved["originalTile"] as? Tile)).isEqual(to: original))
            }
            let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
            XCTAssertEqual(try manager.install(target: target, replacement: replacement), .installed)
            XCTAssertEqual(preferences.writes, 1)
            XCTAssertEqual(try DockShortcutEngine.guid(preferences.pins[0]), 3_097_887_577)
            XCTAssertEqual(try DockShortcutEngine.appURL(preferences.pins[0])?.path, replacement.path)
            let data = try XCTUnwrap(preferences.pins[0]["tile-data"] as? Tile)
            XCTAssertEqual(data["file-label"] as? String, "Owned Launcher")
            XCTAssertEqual(data["bundle-identifier"] as? String, "test.launcher")
            XCTAssertNil(data["book"])
            XCTAssertEqual(try receipt(in: directory).1["state"] as? String, "installed")
            XCTAssertTrue(try manager.isReplaced(target: target))
            XCTAssertEqual(try manager.install(target: target, replacement: replacement), .alreadyReplaced)
            XCTAssertEqual(preferences.writes, 1)
        }
    }

    func testRestoreUsesCurrentPositionAndPreservesUnrelatedGuidlessTiles() throws {
        try withDirectory { root in
            let target = root.appendingPathComponent("Original.app")
            let replacement = root.appendingPathComponent("Launcher.app")
            try makeApp(replacement)
            let original = tile(target)
            let guidless = tile(root.appendingPathComponent("Unrelated.app"), guid: nil)
            let other = tile(root.appendingPathComponent("Other.app"), guid: 22)
            let preferences = Preferences([guidless, original, other])
            let directory = root.appendingPathComponent("Receipts")
            let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
            XCTAssertEqual(try manager.install(target: target, replacement: replacement), .installed)
            XCTAssertTrue(DockShortcutEngine.equal([preferences.pins[0]], [guidless]))
            var owned = preferences.pins[1]
            var ownedData = try XCTUnwrap(owned["tile-data"] as? Tile)
            ownedData["book"] = Data([9, 8, 7]) // Dock-generated caches do not relinquish ownership.
            ownedData["file-mod-date"] = 200
            owned["tile-data"] = ownedData
            var editedOther = other
            editedOther["user-change"] = true
            let newlyPinned = tile(root.appendingPathComponent("New.app"), guid: 33)
            preferences.pins = [editedOther, owned, newlyPinned, guidless]
            XCTAssertEqual(try manager.restore(target: target), .restored)
            XCTAssertTrue(DockShortcutEngine.equal(preferences.pins, [editedOther, original, newlyPinned, guidless]))
            XCTAssertEqual(try receipt(in: directory).1["state"] as? String, "restored")
            XCTAssertFalse(try manager.isReplaced(target: target))
        }
    }

    func testDockFilledFalseMetadataDefaultsPreserveOwnershipForRealAliasPins() throws {
        for replacesOriginal in [false, true] {
            try withDirectory { root in
                let target = root.appendingPathComponent("Original.app")
                let launcher = root.appendingPathComponent("Launcher.app")
                let alias = root.appendingPathComponent("Managed Alias.app")
                try makeApp(target, identifier: "test.original")
                try makeApp(launcher)
                try makeAlias(alias, to: launcher)
                let unrelated = tile(root.appendingPathComponent("User App.app"), guid: nil)
                let original = tile(target)
                let initial = replacesOriginal ? [unrelated, original] : [unrelated]
                let preferences = Preferences(initial)
                let manager = DockShortcutManager(receiptDirectory: root.appendingPathComponent("Receipts"), preferences: preferences.access)
                _ = try manager.install(target: target, replacement: alias, addIfMissing: true)
                var owned = try XCTUnwrap(preferences.pins.last)
                var data = try XCTUnwrap(owned["tile-data"] as? Tile)
                data["dock-extra"] = false
                data["is-beta"] = false
                data["book"] = Data([9, 8, 7])
                data["file-mod-date"] = 0
                data["parent-mod-date"] = 0
                owned["tile-data"] = data
                preferences.pins = [owned, unrelated] // Also preserve a user's new position.
                XCTAssertTrue(try manager.isReplaced(target: target))
                XCTAssertEqual(try manager.install(target: target, replacement: alias, addIfMissing: true), .alreadyReplaced)
                XCTAssertEqual(try manager.restore(target: target), replacesOriginal ? .restored : .removed)
                XCTAssertTrue(DockShortcutEngine.equal(preferences.pins, replacesOriginal ? [original, unrelated] : [unrelated]))
            }
        }
    }

    func testMetadataDefaultNormalizationDoesNotAcceptTrueNonBooleanOrUnknownEdits() throws {
        let original = tile(URL(fileURLWithPath: "/Owned/Launcher.app"))
        for (key, value) in [("dock-extra", true as Any), ("is-beta", true as Any),
                             ("dock-extra", 0 as Any), ("is-beta", "false" as Any),
                             ("user-preference", false as Any)] {
            var changed = original
            var data = try XCTUnwrap(changed["tile-data"] as? Tile)
            data[key] = value
            changed["tile-data"] = data
            XCTAssertFalse(try DockShortcutEngine.samePin(original, changed), key)
            XCTAssertNil(try DockShortcutEngine.ownedIndex(in: [changed], replacement: original), key)
        }
    }

    func testNotPinnedDoesNotWritePreferencesOrCreateReceipt() throws {
        try withDirectory { root in
            let original = tile(root.appendingPathComponent("Unrelated.app"), guid: nil)
            let preferences = Preferences([original, ["unknown-tile": "preserved"]])
            let directory = root.appendingPathComponent("Receipts")
            let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
            XCTAssertEqual(try manager.install(target: root.appendingPathComponent("Missing.app"), replacement: root.appendingPathComponent("Missing Launcher.app")), .notPinned)
            XCTAssertEqual(preferences.writes, 0)
            XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        }
    }

    func testDuplicatesAndMissingMatchingGUIDAreRejected() throws {
        let target = URL(fileURLWithPath: "/Owned/Original.app")
        let replacement = URL(fileURLWithPath: "/Owned/Launcher.app")
        let inputs: [[Tile]] = [
            [tile(target), tile(target, guid: 22)],
            [tile(target), tile(replacement, guid: 22)],
            [tile(target), tile(URL(fileURLWithPath: "/Owned/Other.app"))],
            [tile(target, guid: nil)]
        ]
        for pins in inputs {
            XCTAssertThrowsError(try DockShortcutEngine.replacing(pins, target: target, replacement: replacement, label: "Launcher", bundleIdentifier: "test.launcher"))
        }
    }

    func testChangedOrRemovedOwnedPinReturnsConflictWithoutOverwrite() throws {
        try withDirectory { root in
            let target = root.appendingPathComponent("Original.app")
            let replacement = root.appendingPathComponent("Launcher.app")
            try makeApp(replacement)
            let preferences = Preferences([tile(target)])
            let manager = DockShortcutManager(receiptDirectory: root.appendingPathComponent("Receipts"), preferences: preferences.access)
            _ = try manager.install(target: target, replacement: replacement)
            var data = try XCTUnwrap(preferences.pins[0]["tile-data"] as? Tile)
            data["file-label"] = "User renamed this pin"
            preferences.pins[0]["tile-data"] = data
            let changed = preferences.pins
            guard case .conflict = try manager.restore(target: target) else { return XCTFail("Expected a rename conflict") }
            XCTAssertTrue(DockShortcutEngine.equal(preferences.pins, changed))
            XCTAssertEqual(preferences.writes, 1)
            preferences.pins = []
            guard case .conflict = try manager.restore(target: target) else { return XCTFail("Expected a removed-pin conflict") }
            XCTAssertEqual(preferences.writes, 1)
        }
    }

    func testFailedReadbackRetainsPreparedReceiptAndCanRetry() throws {
        try withDirectory { root in
            let target = root.appendingPathComponent("Original.app")
            let replacement = root.appendingPathComponent("Launcher.app")
            try makeApp(replacement)
            let original = tile(target)
            let preferences = Preferences([original])
            preferences.persistWrites = false
            let directory = root.appendingPathComponent("Receipts")
            let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
            XCTAssertThrowsError(try manager.install(target: target, replacement: replacement))
            XCTAssertEqual(try receipt(in: directory).1["state"] as? String, "prepared")
            XCTAssertTrue(DockShortcutEngine.equal(preferences.pins, [original]))
            preferences.persistWrites = true
            XCTAssertEqual(try manager.install(target: target, replacement: replacement), .installed)
        }
    }

    func testConcurrentEditPreventsWriteAndMalformedReceiptIsPreserved() throws {
        try withDirectory { root in
            let target = root.appendingPathComponent("Original.app")
            let replacement = root.appendingPathComponent("Launcher.app")
            try makeApp(replacement)
            let preferences = Preferences([tile(target)])
            preferences.beforeRead = {
                if preferences.reads == 2 { preferences.pins.append(self.tile(root.appendingPathComponent("Added.app"), guid: 42)) }
            }
            let directory = root.appendingPathComponent("Receipts")
            let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
            XCTAssertThrowsError(try manager.install(target: target, replacement: replacement))
            XCTAssertEqual(preferences.writes, 0)
            XCTAssertEqual(preferences.pins.count, 2)
            let receiptURL = try receipt(in: directory).0
            let malformed = Data("invalid receipt".utf8)
            try malformed.write(to: receiptURL)
            XCTAssertThrowsError(try manager.install(target: target, replacement: replacement))
            XCTAssertEqual(try Data(contentsOf: receiptURL), malformed)
            XCTAssertEqual(preferences.writes, 0)
        }
    }

    func testFinderAliasKeepsPhysicalURLAndUsesResolvedAppMetadata() throws {
        try withDirectory { root in
            let target = root.appendingPathComponent("Original.app")
            let launcher = root.appendingPathComponent("Launcher.app")
            try makeApp(launcher)
            let alias = root.appendingPathComponent("Original with Extensions")
            let bookmark = try launcher.bookmarkData(options: .suitableForBookmarkFile, includingResourceValuesForKeys: nil, relativeTo: nil)
            try URL.writeBookmarkData(bookmark, to: alias)
            XCTAssertEqual(try alias.resourceValues(forKeys: [.isAliasFileKey]).isAliasFile, true)
            let preferences = Preferences([tile(target)])
            let directory = root.appendingPathComponent("Receipts")
            let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
            XCTAssertEqual(try manager.install(target: target, replacement: alias), .installed)
            XCTAssertEqual(try DockShortcutEngine.appURL(preferences.pins[0])?.path, alias.path)
            XCTAssertEqual(try receipt(in: directory).1["replacementURL"] as? String, alias.absoluteString)
            XCTAssertTrue(try manager.isReplaced(target: target))
            XCTAssertEqual(try manager.restore(target: target), .restored)
        }
    }

    func testDirectAliasWithoutBundleIdentifierAddsAndRestoresExactly() throws {
        for identifier in [nil, ""] as [String?] {
            for replacesOriginal in [false, true] {
                try withDirectory { root in
                    let target = root.appendingPathComponent("Original.app")
                    try makeApp(target, identifier: identifier)
                    let alias = root.appendingPathComponent("Original Alias.app")
                    try makeAlias(alias, to: target)
                    let unrelatedApp = root.appendingPathComponent("Unrelated.app")
                    try makeApp(unrelatedApp)
                    let unrelatedAlias = root.appendingPathComponent("Unrelated Alias.app")
                    try makeAlias(unrelatedAlias, to: unrelatedApp)
                    let unrelated = tile(unrelatedAlias, guid: nil)
                    let original = tile(target)
                    let initial = replacesOriginal ? [unrelated, original] : [unrelated]
                    let preferences = Preferences(initial)
                    let directory = root.appendingPathComponent("Receipts")
                    let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)

                    XCTAssertEqual(try manager.install(target: target, replacement: alias, addIfMissing: true), replacesOriginal ? .installed : .added)
                    let owned = try XCTUnwrap(preferences.pins.last)
                    XCTAssertEqual(try DockShortcutEngine.appURL(owned)?.path, alias.path)
                    XCTAssertNil((owned["tile-data"] as? Tile)?["bundle-identifier"])
                    let saved = try receipt(in: directory).1
                    if replacesOriginal {
                        XCTAssertTrue(NSDictionary(dictionary: try XCTUnwrap(saved["originalTile"] as? Tile)).isEqual(to: original))
                    } else {
                        XCTAssertNil(saved["originalTile"])
                    }
                    XCTAssertEqual(try manager.install(target: target, replacement: alias, addIfMissing: true), .alreadyReplaced)
                    XCTAssertTrue(try manager.isReplaced(target: target))
                    XCTAssertEqual(try manager.restore(target: target), replacesOriginal ? .restored : .removed)
                    XCTAssertTrue(DockShortcutEngine.equal(preferences.pins, initial))
                }
            }
        }
    }

    func testAlternativeFinderAliasRejectsFreshInstallWithoutChangingPins() throws {
        for replacesOriginal in [false, true] {
            try withDirectory { root in
                let target = root.appendingPathComponent("Original.app")
                try makeApp(target)
                let alias = root.appendingPathComponent("Managed Alias.app")
                let alternative = root.appendingPathComponent("User Alias.app")
                try makeAlias(alias, to: target)
                try makeAlias(alternative, to: target)
                let userAliasPin = tile(alternative, guid: nil)
                let initial = replacesOriginal ? [tile(target), userAliasPin] : [userAliasPin]
                let preferences = Preferences(initial)
                let directory = root.appendingPathComponent("Receipts")
                let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)

                XCTAssertThrowsError(try manager.install(target: target, replacement: alias, addIfMissing: true)) { error in
                    guard case DockShortcutError.duplicatePin = error else { return XCTFail("Expected an alternative-alias conflict") }
                }
                XCTAssertEqual(preferences.writes, 0)
                XCTAssertTrue(DockShortcutEngine.equal(preferences.pins, initial))
                XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
            }
        }
    }

    func testAlternativeFinderAliasRejectsPreparedRetryAndPreservesReceipt() throws {
        for replacesOriginal in [false, true] {
            try withDirectory { root in
                let target = root.appendingPathComponent("Original.app")
                try makeApp(target)
                let alias = root.appendingPathComponent("Managed Alias.app")
                let alternative = root.appendingPathComponent("User Alias.app")
                try makeAlias(alias, to: target)
                try makeAlias(alternative, to: target)
                let initial = replacesOriginal ? [tile(target)] : []
                let preferences = Preferences(initial)
                preferences.persistWrites = false
                let directory = root.appendingPathComponent("Receipts")
                let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
                XCTAssertThrowsError(try manager.install(target: target, replacement: alias, addIfMissing: true))
                let (receiptURL, saved) = try receipt(in: directory)
                XCTAssertEqual(saved["state"] as? String, "prepared")
                let receiptBytes = try Data(contentsOf: receiptURL)
                preferences.persistWrites = true
                preferences.pins.append(tile(alternative, guid: nil))
                let changedByUser = preferences.pins

                XCTAssertThrowsError(try manager.install(target: target, replacement: alias, addIfMissing: true)) { error in
                    guard case DockShortcutError.duplicatePin = error else { return XCTFail("Expected an alternative-alias conflict") }
                }
                XCTAssertEqual(preferences.writes, 1)
                XCTAssertTrue(DockShortcutEngine.equal(preferences.pins, changedByUser))
                XCTAssertEqual(try Data(contentsOf: receiptURL), receiptBytes)
                preferences.pins = initial
                XCTAssertEqual(try manager.install(target: target, replacement: alias, addIfMissing: true), replacesOriginal ? .installed : .added)
            }
        }
    }

    func testOptionalBundleIdentifierStillRequiresInfoDictionary() throws {
        try withDirectory { root in
            let target = root.appendingPathComponent("Original.app")
            try makeApp(target, identifier: nil)
            let alias = root.appendingPathComponent("Managed Alias.app")
            try makeAlias(alias, to: target)
            try PropertyListSerialization.data(fromPropertyList: ["Not a bundle dictionary"], format: .xml, options: 0)
                .write(to: target.appendingPathComponent("Contents/Info.plist"))
            let original = tile(target)
            let preferences = Preferences([original])
            let directory = root.appendingPathComponent("Receipts")
            let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)

            XCTAssertThrowsError(try manager.install(target: target, replacement: alias)) { error in
                guard case DockShortcutError.invalidApp = error else { return XCTFail("Expected invalid app metadata") }
            }
            XCTAssertEqual(preferences.writes, 0)
            XCTAssertTrue(DockShortcutEngine.equal(preferences.pins, [original]))
            XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        }
    }

    func testAdditionHasNoInventedOriginalAndRemovalPreservesCurrentPins() throws {
        try withDirectory { root in
            let target = root.appendingPathComponent("Original.app")
            let replacement = root.appendingPathComponent("Launcher.app")
            try makeApp(replacement)
            let unrelated = tile(root.appendingPathComponent("Unrelated.app"), guid: nil)
            let unknown: Tile = ["unknown-tile": "preserved"]
            let preferences = Preferences([unrelated, unknown])
            let directory = root.appendingPathComponent("Receipts")
            preferences.beforeWrite = {
                let saved = try self.receipt(in: directory).1
                XCTAssertEqual(saved["version"] as? Int, 2)
                XCTAssertEqual(saved["state"] as? String, "prepared")
                XCTAssertNotNil(saved["ownedGUID"] as? Int64)
                XCTAssertNil(saved["originalTile"])
                XCTAssertNil(saved["originalIndex"])
                XCTAssertNil(saved["originalGUID"])
            }
            let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
            XCTAssertEqual(try manager.install(target: target, replacement: replacement, addIfMissing: true), .added)
            preferences.beforeWrite = nil
            XCTAssertEqual(preferences.pins.count, 3)
            XCTAssertTrue(DockShortcutEngine.equal(Array(preferences.pins.prefix(2)), [unrelated, unknown]))
            let owned = try XCTUnwrap(preferences.pins.last)
            XCTAssertEqual(try DockShortcutEngine.appURL(owned)?.path, replacement.path)
            XCTAssertEqual(try DockShortcutEngine.guid(owned), try receipt(in: directory).1["ownedGUID"] as? Int64)
            XCTAssertEqual(try manager.install(target: target, replacement: replacement, addIfMissing: true), .alreadyReplaced)
            XCTAssertEqual(preferences.writes, 1)
            let userPinnedOriginal = tile(target, guid: 42)
            preferences.pins = [owned, userPinnedOriginal, unknown, unrelated]
            XCTAssertEqual(try manager.restore(target: target), .removed)
            XCTAssertTrue(DockShortcutEngine.equal(preferences.pins, [userPinnedOriginal, unknown, unrelated]))
            XCTAssertEqual(try receipt(in: directory).1["state"] as? String, "removed")
            XCTAssertFalse(try manager.isReplaced(target: target))
            XCTAssertEqual(try manager.restore(target: target), .notPinned)
            XCTAssertEqual(preferences.writes, 2)
        }
    }

    func testAdditionRejectsExistingAliasAndGUIDCollisions() throws {
        try withDirectory { root in
            let target = root.appendingPathComponent("Original.app")
            let replacement = root.appendingPathComponent("Launcher.app")
            try makeApp(replacement)
            let preferences = Preferences([tile(replacement, guid: 42)])
            let directory = root.appendingPathComponent("Receipts")
            let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
            XCTAssertThrowsError(try manager.install(target: target, replacement: replacement, addIfMissing: true))
            XCTAssertEqual(preferences.writes, 0)
            XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
            let other = tile(root.appendingPathComponent("Other.app"), guid: 42)
            XCTAssertThrowsError(try DockShortcutEngine.adding([other], target: target, replacement: replacement, label: "Launcher", bundleIdentifier: "test.launcher", guid: 42))
        }
    }

    func testAddedPinChangedOrDuplicatedIsNotOverwritten() throws {
        try withDirectory { root in
            let target = root.appendingPathComponent("Original.app")
            let replacement = root.appendingPathComponent("Launcher.app")
            try makeApp(replacement)
            let preferences = Preferences([])
            let manager = DockShortcutManager(receiptDirectory: root.appendingPathComponent("Receipts"), preferences: preferences.access)
            _ = try manager.install(target: target, replacement: replacement, addIfMissing: true)
            let owned = preferences.pins[0]
            var renamed = owned
            var data = try XCTUnwrap(renamed["tile-data"] as? Tile)
            data["file-label"] = "User changed this"
            renamed["tile-data"] = data
            for current in [[renamed]] as [[Tile]] {
                preferences.pins = current
                guard case .conflict = try manager.restore(target: target) else { return XCTFail("Expected owned-pin conflict") }
                guard case .conflict = try manager.install(target: target, replacement: replacement, addIfMissing: true) else { return XCTFail("Expected re-add conflict") }
                XCTAssertTrue(DockShortcutEngine.equal(preferences.pins, current))
            }
            var duplicate = owned
            duplicate["GUID"] = try DockShortcutEngine.guid(owned) + 1
            preferences.pins = [owned, duplicate]
            XCTAssertThrowsError(try manager.restore(target: target))
            XCTAssertEqual(preferences.writes, 1)
        }
    }

    func testAlreadyAbsentAdditionRetiresReceiptWithoutWritingDockOrRemovingUserPins() throws {
        try withDirectory { root in
            let target = root.appendingPathComponent("Original.app")
            let replacement = root.appendingPathComponent("Launcher.app")
            try makeApp(replacement)
            let unrelated = tile(root.appendingPathComponent("User App.app"), guid: 42)
            let preferences = Preferences([unrelated])
            let directory = root.appendingPathComponent("Receipts")
            let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
            XCTAssertEqual(try manager.install(target: target, replacement: replacement, addIfMissing: true), .added)
            let manuallyPinnedOriginal = tile(target, guid: 43)
            preferences.pins = [manuallyPinnedOriginal, unrelated]
            let writes = preferences.writes
            let reads = preferences.reads
            XCTAssertEqual(try manager.restore(target: target), .removed)
            XCTAssertGreaterThanOrEqual(preferences.reads - reads, 2)
            XCTAssertEqual(preferences.writes, writes)
            XCTAssertTrue(DockShortcutEngine.equal(preferences.pins, [manuallyPinnedOriginal, unrelated]))
            XCTAssertEqual(try receipt(in: directory).1["state"] as? String, "removed")
            XCTAssertEqual(try manager.restore(target: target), .notPinned)
            XCTAssertEqual(preferences.writes, writes)
        }
    }

    func testAddedAliasWithDifferentGUIDStillConflictsDuringAbsenceRecovery() throws {
        try withDirectory { root in
            let target = root.appendingPathComponent("Original.app")
            let replacement = root.appendingPathComponent("Launcher.app")
            try makeApp(replacement)
            let preferences = Preferences([])
            let directory = root.appendingPathComponent("Receipts")
            let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
            _ = try manager.install(target: target, replacement: replacement, addIfMissing: true)
            var changed = preferences.pins[0]
            changed["GUID"] = try DockShortcutEngine.guid(changed) + 1
            preferences.pins = [changed]
            guard case .conflict = try manager.restore(target: target) else { return XCTFail("Expected changed-GUID conflict") }
            XCTAssertEqual(preferences.writes, 1)
            XCTAssertEqual(try receipt(in: directory).1["state"] as? String, "installed")
        }
    }

    func testAdditionReappearingAtSecondReadDoesNotRetireReceiptOrWriteDock() throws {
        try withDirectory { root in
            let target = root.appendingPathComponent("Original.app")
            let replacement = root.appendingPathComponent("Launcher.app")
            try makeApp(replacement)
            let preferences = Preferences([])
            let directory = root.appendingPathComponent("Receipts")
            let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
            _ = try manager.install(target: target, replacement: replacement, addIfMissing: true)
            let owned = preferences.pins[0]
            preferences.pins = []
            var reads = 0
            preferences.beforeRead = {
                reads += 1
                if reads == 2 { preferences.pins = [owned] }
            }
            guard case .conflict = try manager.restore(target: target) else { return XCTFail("Expected concurrent-reappearance conflict") }
            XCTAssertEqual(preferences.writes, 1)
            XCTAssertEqual(try receipt(in: directory).1["state"] as? String, "installed")
        }
    }

    func testPreparedAdditionRetriesWithTheSameOwnedGUID() throws {
        try withDirectory { root in
            let target = root.appendingPathComponent("Original.app")
            let replacement = root.appendingPathComponent("Launcher.app")
            try makeApp(replacement)
            let preferences = Preferences([])
            preferences.persistWrites = false
            let directory = root.appendingPathComponent("Receipts")
            let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
            XCTAssertThrowsError(try manager.install(target: target, replacement: replacement, addIfMissing: true))
            let saved = try receipt(in: directory).1
            let guid = try XCTUnwrap(saved["ownedGUID"] as? Int64)
            XCTAssertEqual(saved["state"] as? String, "prepared")
            XCTAssertTrue(preferences.pins.isEmpty)
            XCTAssertEqual(try manager.install(target: target, replacement: replacement), .notPinned)
            preferences.pins = [tile(root.appendingPathComponent("User Pin.app"), guid: nil)]
            preferences.persistWrites = true
            XCTAssertEqual(try manager.install(target: target, replacement: replacement, addIfMissing: true), .added)
            XCTAssertEqual(try DockShortcutEngine.guid(try XCTUnwrap(preferences.pins.last)), guid)
            XCTAssertEqual(preferences.pins.count, 2)
        }
    }

    func testPreparedAdditionWillNotReuseACollidingGUID() throws {
        try withDirectory { root in
            let target = root.appendingPathComponent("Original.app")
            let replacement = root.appendingPathComponent("Launcher.app")
            try makeApp(replacement)
            let preferences = Preferences([])
            preferences.persistWrites = false
            let directory = root.appendingPathComponent("Receipts")
            let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
            XCTAssertThrowsError(try manager.install(target: target, replacement: replacement, addIfMissing: true))
            let guid = try XCTUnwrap(receipt(in: directory).1["ownedGUID"] as? Int64)
            let userPin = tile(root.appendingPathComponent("User Pin.app"), guid: guid)
            preferences.pins = [userPin]
            preferences.persistWrites = true
            guard case .conflict = try manager.install(target: target, replacement: replacement, addIfMissing: true) else { return XCTFail("Expected GUID conflict") }
            XCTAssertTrue(DockShortcutEngine.equal(preferences.pins, [userPin]))
            XCTAssertEqual(preferences.writes, 1)
        }
    }

    func testReturnedRemovedAdditionIsReadoptedWithoutDockWrite() throws {
        try withDirectory { root in
            let target = root.appendingPathComponent("Original.app")
            let replacement = root.appendingPathComponent("Launcher.app")
            try makeApp(replacement)
            let unrelated = tile(root.appendingPathComponent("User App.app"), guid: 22)
            let preferences = Preferences([unrelated])
            let directory = root.appendingPathComponent("Receipts")
            let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
            XCTAssertEqual(try manager.install(target: target, replacement: replacement, addIfMissing: true), .added)
            let owned = try XCTUnwrap(preferences.pins.last)
            XCTAssertEqual(try manager.restore(target: target), .removed)
            preferences.pins = [owned, unrelated]
            XCTAssertEqual(try manager.install(target: target, replacement: replacement, addIfMissing: true), .alreadyReplaced)
            XCTAssertEqual(preferences.writes, 2, "Re-adoption writes only its receipt")
            XCTAssertEqual(try receipt(in: directory).1["state"] as? String, "installed")
            XCTAssertTrue(DockShortcutEngine.equal(preferences.pins, [owned, unrelated]))
            XCTAssertEqual(try manager.restore(target: target), .removed)
            XCTAssertTrue(DockShortcutEngine.equal(preferences.pins, [unrelated]))
        }
    }

    func testReturnedRemovedAdditionIsRemovedWithDurableIntentAndPreservesOtherPins() throws {
        try withDirectory { root in
            let target = root.appendingPathComponent("Original.app")
            let replacement = root.appendingPathComponent("Launcher.app")
            try makeApp(replacement)
            let unrelated = tile(root.appendingPathComponent("User App.app"), guid: nil)
            let preferences = Preferences([unrelated])
            let directory = root.appendingPathComponent("Receipts")
            let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
            _ = try manager.install(target: target, replacement: replacement, addIfMissing: true)
            var owned = try XCTUnwrap(preferences.pins.last)
            _ = try manager.restore(target: target)
            var data = try XCTUnwrap(owned["tile-data"] as? Tile)
            data["book"] = Data([7, 8, 9]); data["dock-extra"] = false; data["is-beta"] = false
            owned["tile-data"] = data
            let laterPin = tile(root.appendingPathComponent("Later User App.app"), guid: 23)
            preferences.pins = [laterPin, owned, unrelated]
            preferences.beforeWrite = {
                XCTAssertEqual(try self.receipt(in: directory).1["state"] as? String, "restoring")
            }
            XCTAssertEqual(try manager.restore(target: target), .removed)
            XCTAssertEqual(preferences.writes, 3)
            XCTAssertTrue(DockShortcutEngine.equal(preferences.pins, [laterPin, unrelated]))
            XCTAssertEqual(try receipt(in: directory).1["state"] as? String, "removed")
            XCTAssertEqual(try manager.restore(target: target), .notPinned)
            XCTAssertEqual(preferences.writes, 3)
        }
    }

    func testRemovedAdditionRejectsChangedDuplicateAndOriginalTargetPins() throws {
        for mode in ["changed", "duplicate-guid", "duplicate-alias", "different-guid", "original-target"] {
            try withDirectory { root in
                let target = root.appendingPathComponent("Original.app")
                let replacement = root.appendingPathComponent("Launcher.app")
                try makeApp(replacement)
                let preferences = Preferences([])
                let directory = root.appendingPathComponent("Receipts")
                let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
                _ = try manager.install(target: target, replacement: replacement, addIfMissing: true)
                let owned = try XCTUnwrap(preferences.pins.first)
                let ownedGUID = try DockShortcutEngine.guid(owned)
                _ = try manager.restore(target: target)
                var changed = owned
                if mode == "changed" {
                    var data = try XCTUnwrap(changed["tile-data"] as? Tile)
                    data["file-label"] = "User edited this pin"; changed["tile-data"] = data
                    preferences.pins = [changed]
                } else if mode == "duplicate-guid" {
                    preferences.pins = [owned, tile(root.appendingPathComponent("Other.app"), guid: ownedGUID)]
                } else if mode == "duplicate-alias" {
                    changed["GUID"] = ownedGUID + 1; preferences.pins = [owned, changed]
                } else if mode == "different-guid" {
                    changed["GUID"] = ownedGUID + 1; preferences.pins = [changed]
                } else {
                    preferences.pins = [owned, tile(target, guid: ownedGUID + 1)]
                }
                let before = preferences.pins
                for install in [true, false] {
                    do {
                        let outcome: DockShortcutOutcome
                        if install { outcome = try manager.install(target: target, replacement: replacement, addIfMissing: true) }
                        else { outcome = try manager.restore(target: target) }
                        guard case .conflict = outcome else { return XCTFail("Expected conflict for \(mode)") }
                    } catch DockShortcutError.duplicatePin { /* Exact duplicate remains a conflict. */ }
                    XCTAssertEqual(preferences.writes, 2)
                    XCTAssertTrue(DockShortcutEngine.equal(preferences.pins, before))
                    XCTAssertEqual(try receipt(in: directory).1["state"] as? String, "removed")
                }
            }
        }
    }

    func testReturnedRemovedAdditionIsRecheckedBeforeReadoptionOrRemoval() throws {
        for install in [true, false] {
            try withDirectory { root in
                let target = root.appendingPathComponent("Original.app")
                let replacement = root.appendingPathComponent("Launcher.app")
                try makeApp(replacement)
                let preferences = Preferences([])
                let directory = root.appendingPathComponent("Receipts")
                let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
                _ = try manager.install(target: target, replacement: replacement, addIfMissing: true)
                let owned = try XCTUnwrap(preferences.pins.first)
                _ = try manager.restore(target: target)
                preferences.pins = [owned]
                let initialReads = preferences.reads
                preferences.beforeRead = {
                    if preferences.reads == initialReads + 2 {
                        preferences.pins[0]["user-edit"] = true
                    }
                }
                if install {
                    guard case .conflict = try manager.install(target: target, replacement: replacement, addIfMissing: true) else {
                        return XCTFail("Expected changed-pin conflict")
                    }
                    XCTAssertEqual(try receipt(in: directory).1["state"] as? String, "removed")
                } else {
                    XCTAssertThrowsError(try manager.restore(target: target))
                    XCTAssertEqual(try receipt(in: directory).1["state"] as? String, "restoring")
                }
                XCTAssertEqual(preferences.writes, 2)
                XCTAssertEqual(preferences.pins[0]["user-edit"] as? Bool, true)
            }
        }
    }

    func testRestoreRecoveryAfterWrittenPreferencesForAdditionAndLegacyReceipt() throws {
        for replacesOriginal in [false, true] {
            try withDirectory { root in
                let target = root.appendingPathComponent("Original.app")
                let replacement = root.appendingPathComponent("Launcher.app")
                try makeApp(replacement)
                let original = tile(target)
                let preferences = Preferences(replacesOriginal ? [original] : [])
                let directory = root.appendingPathComponent("Receipts")
                let manager = DockShortcutManager(receiptDirectory: directory, preferences: preferences.access)
                _ = try manager.install(target: target, replacement: replacement, addIfMissing: true)
                if replacesOriginal {
                    let (file, saved) = try receipt(in: directory)
                    var legacy = saved
                    legacy["version"] = 1
                    legacy.removeValue(forKey: "ownedGUID")
                    try PropertyListSerialization.data(fromPropertyList: legacy, format: .binary, options: 0).write(to: file)
                    XCTAssertTrue(try manager.isReplaced(target: target))
                }
                preferences.beforeRead = {
                    if preferences.writes == 2 {
                        preferences.beforeRead = nil
                        throw DockShortcutError.verificationFailed
                    }
                }
                XCTAssertThrowsError(try manager.restore(target: target))
                XCTAssertEqual(try receipt(in: directory).1["state"] as? String, "restoring")
                XCTAssertTrue(DockShortcutEngine.equal(preferences.pins, replacesOriginal ? [original] : []))
                let unrelated = tile(root.appendingPathComponent("New User Pin.app"), guid: nil)
                preferences.pins.append(unrelated)
                XCTAssertEqual(try manager.restore(target: target), replacesOriginal ? .restored : .removed)
                XCTAssertEqual(preferences.writes, 2, "Recovery must not rewrite current preferences")
                XCTAssertTrue(DockShortcutEngine.equal(preferences.pins, replacesOriginal ? [original, unrelated] : [unrelated]))
                XCTAssertEqual(try receipt(in: directory).1["state"] as? String, replacesOriginal ? "restored" : "removed")
            }
        }
    }
}

private extension Array {
    var only: Element? { count == 1 ? first : nil }
}
