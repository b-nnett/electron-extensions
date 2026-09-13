import Foundation
import CoreFoundation
import CryptoKit

enum DockShortcutOutcome: Equatable, Sendable {
    case installed, restored, added, removed, notPinned, alreadyReplaced
    case conflict(String)
}

enum DockShortcutError: LocalizedError {
    case invalidApp, malformedPreferences, duplicatePin, invalidReceipt, synchronizationFailed, verificationFailed

    var errorDescription: String? {
        switch self {
        case .invalidApp: "Choose a local application bundle with a valid Info.plist."
        case .malformedPreferences: "The Dock's app pins are malformed. Nothing was replaced."
        case .duplicatePin: "The Dock contains ambiguous or duplicate pins. Nothing was replaced."
        case .invalidReceipt: "The saved Dock receipt is invalid and has been preserved."
        case .synchronizationFailed: "Dock preferences could not be synchronized. The recovery receipt has been preserved."
        case .verificationFailed: "Dock preferences changed during this operation or could not be verified. The recovery receipt has been preserved."
        }
    }
}

/// Property-list values stay on the caller's actor; this engine never reads or changes preferences.
enum DockShortcutEngine {
    typealias Tile = [String: Any]
    static let cacheKeys = ["book", "file-mod-date", "parent-mod-date", "file-icon", "file-icon-data", "icon"]

    static func canonical(_ url: URL) throws -> URL {
        guard url.isFileURL, !url.path.isEmpty, url.path != "/" else { throw DockShortcutError.invalidApp }
        // Finder aliases retain their physical path; only POSIX symlinks are canonicalized.
        return url.standardizedFileURL.resolvingSymlinksInPath()
    }

    static func optionalGUID(_ tile: Tile) -> Int64? {
        guard let value = tile["GUID"] as? NSNumber,
              CFGetTypeID(value) != CFBooleanGetTypeID(), value.int64Value > 0,
              value.doubleValue == Double(value.int64Value) else { return nil }
        return value.int64Value
    }

    static func guid(_ tile: Tile) throws -> Int64 {
        guard let value = optionalGUID(tile) else { throw DockShortcutError.malformedPreferences }
        return value
    }

    static func appURL(_ tile: Tile) throws -> URL? {
        guard let type = tile["tile-type"] as? String,
              let data = tile["tile-data"] as? Tile else { return nil }
        guard type == "file-tile" else { return nil }
        guard let file = data["file-data"] as? Tile,
              let string = file["_CFURLString"] as? String else { return nil }
        let url: URL
        if string.hasPrefix("/") { url = URL(fileURLWithPath: string) }
        else if let parsed = URL(string: string), parsed.isFileURL { url = parsed }
        else { return nil }
        // File tiles can point to non-app files; preserve them without treating them as app pins.
        return url.standardizedFileURL.resolvingSymlinksInPath()
    }

    static func validate(_ pins: [Tile]) throws {
        guard PropertyListSerialization.propertyList(pins, isValidFor: .binary) else { throw DockShortcutError.malformedPreferences }
    }

    static func matching(_ url: URL, in pins: [Tile]) throws -> [Int] {
        try validate(pins)
        return try pins.indices.filter { try appURL(pins[$0])?.path == url.path }
    }

    static func equal(_ lhs: [Tile], _ rhs: [Tile]) -> Bool { NSArray(array: lhs).isEqual(to: rhs) }

    static func stable(_ tile: Tile) throws -> Tile {
        var result = tile
        if var data = result["tile-data"] as? Tile {
            for key in cacheKeys { data.removeValue(forKey: key) }
            // Dock fills these absent metadata defaults with Boolean false.
            // Preserve true, non-Boolean and unknown fields as ownership edits.
            for key in ["dock-extra", "is-beta"] {
                if let value = data[key] as? NSNumber,
                   CFGetTypeID(value) == CFBooleanGetTypeID(), !value.boolValue {
                    data.removeValue(forKey: key)
                }
            }
            if let url = try appURL(tile) {
                data["file-data"] = ["_CFURLString": url.absoluteString, "_CFURLStringType": 15]
            }
            result["tile-data"] = data
        }
        return result
    }

    static func samePin(_ lhs: Tile, _ rhs: Tile) throws -> Bool {
        NSDictionary(dictionary: try stable(lhs)).isEqual(to: try stable(rhs))
    }

    static func replacing(
        _ pins: [Tile], target: URL, replacement: URL, label: String, bundleIdentifier: String?
    ) throws -> (pins: [Tile], index: Int, original: Tile, replacement: Tile)? {
        let matches = try matching(target, in: pins)
        guard matches.count <= 1 else { throw DockShortcutError.duplicatePin }
        guard let index = matches.first else { return nil }
        guard target.path != replacement.path, try matching(replacement, in: pins).isEmpty else { throw DockShortcutError.duplicatePin }
        let original = pins[index]
        let originalGUID = try guid(original)
        guard pins.filter({ optionalGUID($0) == originalGUID }).count == 1 else { throw DockShortcutError.duplicatePin }
        var tile = original
        var data = original["tile-data"] as! Tile // Validated by matching above.
        for key in cacheKeys { data.removeValue(forKey: key) }
        data["file-data"] = ["_CFURLString": replacement.absoluteString, "_CFURLStringType": 15]
        data["file-label"] = label
        if let bundleIdentifier { data["bundle-identifier"] = bundleIdentifier }
        else { data.removeValue(forKey: "bundle-identifier") }
        tile["tile-data"] = data
        var result = pins
        result[index] = tile
        return (result, index, original, tile)
    }

    static func ownedIndex(in pins: [Tile], replacement: Tile) throws -> Int? {
        try validate(pins)
        let expectedGUID = try guid(replacement)
        let indexes = pins.indices.filter { optionalGUID(pins[$0]) == expectedGUID }
        guard indexes.count <= 1 else { throw DockShortcutError.duplicatePin }
        guard let index = indexes.first, try samePin(pins[index], replacement) else { return nil }
        guard let url = try appURL(replacement), try matching(url, in: pins).count == 1 else { throw DockShortcutError.duplicatePin }
        return index
    }

    static func restoring(_ pins: [Tile], original: Tile, replacement: Tile) throws -> [Tile]? {
        guard let index = try ownedIndex(in: pins, replacement: replacement), let target = try appURL(original) else { return nil }
        guard try matching(target, in: pins).isEmpty else { return nil }
        var result = pins
        result[index] = original
        return result
    }

    static func adding(
        _ pins: [Tile], target: URL, replacement: URL, label: String, bundleIdentifier: String?, guid: Int64
    ) throws -> (pins: [Tile], tile: Tile) {
        guard target.path != replacement.path, guid > 0,
              try matching(target, in: pins).isEmpty, try matching(replacement, in: pins).isEmpty,
              !pins.contains(where: { optionalGUID($0) == guid }) else { throw DockShortcutError.duplicatePin }
        var data: Tile = [
            "file-data": ["_CFURLString": replacement.absoluteString, "_CFURLStringType": 15],
            "file-label": label, "file-type": 41
        ]
        if let bundleIdentifier { data["bundle-identifier"] = bundleIdentifier }
        let tile: Tile = ["GUID": guid, "tile-type": "file-tile", "tile-data": data]
        return (pins + [tile], tile)
    }

    static func removing(_ pins: [Tile], replacement: Tile) throws -> [Tile]? {
        guard let index = try ownedIndex(in: pins, replacement: replacement) else { return nil }
        var result = pins
        result.remove(at: index)
        return result
    }
}

@MainActor
struct DockPreferencesAccess {
    var read: () throws -> [DockShortcutEngine.Tile]
    var write: ([DockShortcutEngine.Tile]) throws -> Void
    var refresh: () throws -> Void

    static var live: Self {
        let domain = "com.apple.dock" as CFString
        let key = "persistent-apps" as CFString
        return Self(read: {
            guard let value = CFPreferencesCopyValue(key, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) else { return [] }
            guard let pins = value as? [[String: Any]] else { throw DockShortcutError.malformedPreferences }
            return pins
        }, write: { pins in
            CFPreferencesSetValue(key, pins as CFArray, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        }, refresh: {
            guard CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) else {
                throw DockShortcutError.synchronizationFailed
            }
        })
    }
}

private struct DockReceipt {
    var state: String
    let target: URL
    let replacement: URL
    let originalIndex: Int?
    let originalTile: DockShortcutEngine.Tile?
    let replacementTile: DockShortcutEngine.Tile

    var plist: [String: Any] {
        get throws {
            var value: [String: Any] = [
                "version": 2, "state": state, "targetURL": target.absoluteString,
                "replacementURL": replacement.absoluteString,
                "ownedGUID": try DockShortcutEngine.guid(replacementTile),
                "replacementTile": replacementTile, "updatedAt": Date()
            ]
            if let originalTile, let originalIndex {
                value["originalTile"] = originalTile
                value["originalIndex"] = originalIndex
                value["originalGUID"] = try DockShortcutEngine.guid(originalTile)
            }
            return value
        }
    }

    init(state: String, target: URL, replacement: URL, originalIndex: Int? = nil, originalTile: DockShortcutEngine.Tile? = nil, replacementTile: DockShortcutEngine.Tile) {
        self.state = state; self.target = target; self.replacement = replacement
        self.originalIndex = originalIndex; self.originalTile = originalTile; self.replacementTile = replacementTile
    }

    init(data: Data) throws {
        guard let value = try PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
              let version = value["version"] as? Int, [1, 2].contains(version),
              let state = value["state"] as? String,
              ["prepared", "installed", "restoring", "restored", "removed"].contains(state),
              let targetString = value["targetURL"] as? String, let target = URL(string: targetString),
              let replacementString = value["replacementURL"] as? String, let replacement = URL(string: replacementString),
              let replaced = value["replacementTile"] as? DockShortcutEngine.Tile else { throw DockShortcutError.invalidReceipt }
        let original = value["originalTile"] as? DockShortcutEngine.Tile
        let index = value["originalIndex"] as? Int
        if let original {
            guard let index, index >= 0,
                  let guid = value["originalGUID"] as? Int64,
                  try DockShortcutEngine.guid(original) == guid,
                  try DockShortcutEngine.guid(replaced) == guid,
                  state != "removed" else { throw DockShortcutError.invalidReceipt }
            try DockShortcutEngine.validate([original])
        } else {
            guard version == 2, value["originalTile"] == nil, value["originalIndex"] == nil,
                  value["originalGUID"] == nil, state != "restored" else { throw DockShortcutError.invalidReceipt }
        }
        if version == 2 {
            guard let guid = value["ownedGUID"] as? Int64,
                  try DockShortcutEngine.guid(replaced) == guid else { throw DockShortcutError.invalidReceipt }
        }
        self.init(state: state, target: try DockShortcutEngine.canonical(target), replacement: try DockShortcutEngine.canonical(replacement), originalIndex: index, originalTile: original, replacementTile: replaced)
        try DockShortcutEngine.validate([replaced])
        if let original {
            guard try DockShortcutEngine.appURL(original)?.path == self.target.path else { throw DockShortcutError.invalidReceipt }
        }
        guard try DockShortcutEngine.appURL(replaced)?.path == self.replacement.path,
              self.target.path != self.replacement.path else { throw DockShortcutError.invalidReceipt }
    }
}

/// Replaces one pin, or explicitly adds one owned pin. Dock restart is a separate caller action.
@MainActor
struct DockShortcutManager {
    let receiptDirectory: URL
    private let preferences: DockPreferencesAccess

    static var defaultReceiptDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Extensions Anywhere/DockReceipts", isDirectory: true)
    }

    init(receiptDirectory: URL = defaultReceiptDirectory) {
        self.init(receiptDirectory: receiptDirectory, preferences: .live)
    }

    init(receiptDirectory: URL, preferences: DockPreferencesAccess) {
        self.receiptDirectory = receiptDirectory
        self.preferences = preferences
    }

    func pinsSnapshot() throws -> [URL] {
        let pins = try currentPins()
        return try pins.compactMap { try DockShortcutEngine.appURL($0) }
    }

    func isReplaced(target: URL) throws -> Bool {
        let target = try DockShortcutEngine.canonical(target)
        guard let receipt = try loadReceipt(target) else { return false }
        guard !["restored", "removed"].contains(receipt.state) else { return false }
        return try DockShortcutEngine.ownedIndex(in: currentPins(), replacement: receipt.replacementTile) != nil
    }

    func install(target: URL, replacement: URL, addIfMissing: Bool = false) throws -> DockShortcutOutcome {
        let target = try DockShortcutEngine.canonical(target)
        let replacement = try DockShortcutEngine.canonical(replacement)
        let pins = try currentPins()
        var preparedAdditionGUID: Int64?
        // A previously removed addition can reappear in Dock's current state.
        // Re-adopt only the exact recorded pin, never a new or edited user pin.
        if var removed = try loadReceipt(target), removed.state == "removed",
           !(try restorationAlreadyApplied(removed, in: pins)) {
            guard removed.replacement.path == replacement.path,
                  try returnedAdditionIsOwned(removed, in: pins),
                  try returnedAdditionIsOwned(removed, in: currentPins()) else {
                return .conflict("The previously removed shortcut conflicts with a current Dock pin. The Dock was left unchanged.")
            }
            removed.state = "installed"
            try saveReceipt(removed)
            return .alreadyReplaced
        }
        if var existing = try loadReceipt(target), !["restored", "removed"].contains(existing.state) {
            guard existing.replacement.path == replacement.path else { return .conflict("This app already has a receipt for another shortcut.") }
            if try DockShortcutEngine.ownedIndex(in: pins, replacement: existing.replacementTile) != nil {
                if existing.state != "installed" {
                    existing.state = "installed"
                    try saveReceipt(existing)
                }
                return .alreadyReplaced
            }
            let originals = try DockShortcutEngine.matching(target, in: pins)
            guard existing.state == "prepared" else {
                return .conflict("The saved shortcut was changed or removed. The Dock was left unchanged.")
            }
            if let original = existing.originalTile {
                guard originals.count == 1, try DockShortcutEngine.samePin(pins[originals[0]], original) else {
                    return .conflict("The saved original pin was changed or removed. The Dock was left unchanged.")
                }
            } else {
                let guid = try DockShortcutEngine.guid(existing.replacementTile)
                guard originals.isEmpty, try DockShortcutEngine.matching(replacement, in: pins).isEmpty,
                      !pins.contains(where: { DockShortcutEngine.optionalGUID($0) == guid }) else {
                    return .conflict("The pending shortcut conflicts with a current Dock pin. The Dock was left unchanged.")
                }
                preparedAdditionGUID = guid
            }
        }
        let originals = try DockShortcutEngine.matching(target, in: pins)
        guard originals.count <= 1 else { throw DockShortcutError.duplicatePin }
        guard !originals.isEmpty || addIfMissing else { return .notPinned }
        try rejectAlternativeAliases(in: pins, target: target, replacement: replacement)
        let replacementApp: URL
        if try replacement.resourceValues(forKeys: [.isAliasFileKey]).isAliasFile == true {
            replacementApp = try URL(resolvingAliasFileAt: replacement, options: [.withoutUI, .withoutMounting])
        } else { replacementApp = replacement }
        guard replacementApp.pathExtension.lowercased() == "app" else { throw DockShortcutError.invalidApp }
        let infoURL = replacementApp.appendingPathComponent("Contents/Info.plist")
        guard let info = try PropertyListSerialization.propertyList(from: Data(contentsOf: infoURL), options: [], format: nil) as? [String: Any] else { throw DockShortcutError.invalidApp }
        let identifier = (info["CFBundleIdentifier"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let label = (info["CFBundleDisplayName"] as? String) ?? (info["CFBundleName"] as? String) ?? replacement.deletingPathExtension().lastPathComponent
        var receipt: DockReceipt
        let changed: [DockShortcutEngine.Tile]
        let outcome: DockShortcutOutcome
        if let plan = try DockShortcutEngine.replacing(pins, target: target, replacement: replacement, label: label, bundleIdentifier: identifier) {
            receipt = DockReceipt(state: "prepared", target: target, replacement: replacement, originalIndex: plan.index, originalTile: plan.original, replacementTile: plan.replacement)
            changed = plan.pins
            outcome = .installed
        } else {
            let guid = try preparedAdditionGUID ?? unusedGUID(in: pins)
            let plan = try DockShortcutEngine.adding(pins, target: target, replacement: replacement, label: label, bundleIdentifier: identifier, guid: guid)
            receipt = DockReceipt(state: "prepared", target: target, replacement: replacement, replacementTile: plan.tile)
            changed = plan.pins
            outcome = .added
        }
        try saveReceipt(receipt)
        try change(from: pins, to: changed)
        receipt.state = "installed"
        try saveReceipt(receipt)
        return outcome
    }

    func restore(target: URL) throws -> DockShortcutOutcome {
        let target = try DockShortcutEngine.canonical(target)
        guard var receipt = try loadReceipt(target) else { return .notPinned }
        let pins = try currentPins()
        if receipt.state == "restored" { return .notPinned }
        if receipt.state == "removed" {
            if try restorationAlreadyApplied(receipt, in: pins),
               try restorationAlreadyApplied(receipt, in: currentPins()) { return .notPinned }
            guard try returnedAdditionIsOwned(receipt, in: pins) else {
                return .conflict("The previously removed shortcut was changed or duplicated. Other Dock changes were preserved.")
            }
            // Continue through the ordinary durable restore intent and verified
            // preferences write, including the fresh-state check in change().
        }
        let finalState = receipt.originalTile == nil ? "removed" : "restored"
        let outcome: DockShortcutOutcome = receipt.originalTile == nil ? .removed : .restored
        // A durable restore intent may outlive its successful preferences write.
        // A pin we added may already be absent (for example, removed through
        // Dock). Last-disable already has its desired outcome in that case.
        // Retire only an addition receipt after a fresh second absence check;
        // never write preferences, resurrect a pin, or accept a changed alias.
        if receipt.state == "installed", receipt.originalTile == nil,
           try restorationAlreadyApplied(receipt, in: pins),
           try restorationAlreadyApplied(receipt, in: currentPins()) {
            receipt.state = "removed"
            try saveReceipt(receipt)
            return .removed
        }
        if receipt.state == "restoring", try restorationAlreadyApplied(receipt, in: pins) {
            receipt.state = finalState
            try saveReceipt(receipt)
            return outcome
        }
        let restored: [DockShortcutEngine.Tile]?
        if let original = receipt.originalTile {
            restored = try DockShortcutEngine.restoring(pins, original: original, replacement: receipt.replacementTile)
        } else {
            restored = try DockShortcutEngine.removing(pins, replacement: receipt.replacementTile)
        }
        guard let restored else {
            return .conflict("The owned shortcut was changed, removed, or duplicated. Other Dock changes were preserved.")
        }
        receipt.state = "restoring"
        try saveReceipt(receipt)
        try change(from: pins, to: restored)
        receipt.state = finalState
        try saveReceipt(receipt)
        return outcome
    }

    private func unusedGUID(in pins: [DockShortcutEngine.Tile]) throws -> Int64 {
        let existing = Set(pins.compactMap { DockShortcutEngine.optionalGUID($0) })
        for _ in 0..<32 {
            let candidate = Int64.random(in: 1...Int64(UInt32.max))
            if !existing.contains(candidate) { return candidate }
        }
        throw DockShortcutError.duplicatePin
    }

    private func rejectAlternativeAliases(in pins: [DockShortcutEngine.Tile], target: URL, replacement: URL) throws {
        for pin in pins {
            guard let url = try DockShortcutEngine.appURL(pin),
                  url.path != target.path, url.path != replacement.path,
                  (try? url.resourceValues(forKeys: [.isAliasFileKey]).isAliasFile) == true,
                  let resolved = try? URL(resolvingAliasFileAt: url, options: [.withoutUI, .withoutMounting]) else { continue }
            // Resolution detects ambiguity only; receipts and ownership keep the physical alias URL.
            if try DockShortcutEngine.canonical(resolved).path == target.path {
                throw DockShortcutError.duplicatePin
            }
        }
    }

    private func restorationAlreadyApplied(_ receipt: DockReceipt, in pins: [DockShortcutEngine.Tile]) throws -> Bool {
        guard try DockShortcutEngine.matching(receipt.replacement, in: pins).isEmpty else { return false }
        if let original = receipt.originalTile {
            return try DockShortcutEngine.ownedIndex(in: pins, replacement: original) != nil
        }
        let guid = try DockShortcutEngine.guid(receipt.replacementTile)
        return !pins.contains { DockShortcutEngine.optionalGUID($0) == guid }
    }

    private func returnedAdditionIsOwned(_ receipt: DockReceipt, in pins: [DockShortcutEngine.Tile]) throws -> Bool {
        guard receipt.state == "removed", receipt.originalTile == nil,
              try DockShortcutEngine.matching(receipt.target, in: pins).isEmpty,
              try DockShortcutEngine.ownedIndex(in: pins, replacement: receipt.replacementTile) != nil else { return false }
        try rejectAlternativeAliases(in: pins, target: receipt.target, replacement: receipt.replacement)
        return true
    }

    static func restartDock() throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/killall")
        process.arguments = ["Dock"]
        try process.run()
        process.waitUntilExit()
        guard process.terminationReason == .exit, process.terminationStatus == 0 else { throw DockShortcutError.synchronizationFailed }
    }

    private func currentPins() throws -> [DockShortcutEngine.Tile] {
        try preferences.refresh()
        let pins = try preferences.read()
        try DockShortcutEngine.validate(pins)
        return pins
    }

    private func change(from original: [DockShortcutEngine.Tile], to replacement: [DockShortcutEngine.Tile]) throws {
        guard DockShortcutEngine.equal(try currentPins(), original) else { throw DockShortcutError.verificationFailed }
        try preferences.write(replacement)
        guard DockShortcutEngine.equal(try currentPins(), replacement) else { throw DockShortcutError.verificationFailed }
    }

    private func receiptURL(_ target: URL) -> URL {
        let hash = SHA256.hash(data: Data(target.path.utf8)).map { String(format: "%02x", $0) }.joined()
        return receiptDirectory.appendingPathComponent(hash + ".plist")
    }

    private func loadReceipt(_ target: URL) throws -> DockReceipt? {
        let data: Data
        do { data = try Data(contentsOf: receiptURL(target)) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
        let receipt = try DockReceipt(data: data)
        guard receipt.target.path == target.path else { throw DockShortcutError.invalidReceipt }
        return receipt
    }

    private func saveReceipt(_ receipt: DockReceipt) throws {
        let data = try PropertyListSerialization.data(fromPropertyList: receipt.plist, format: .binary, options: 0)
        try FileManager.default.createDirectory(at: receiptDirectory, withIntermediateDirectories: true)
        try data.write(to: receiptURL(receipt.target), options: .atomic)
    }
}
