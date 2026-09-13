import AppKit
import CoreFoundation
import Darwin
import Foundation
import Observation

enum DockVisibilityError: LocalizedError {
    case invalidPreference, synchronizationFailed, verificationFailed, invalidReceipt

    var errorDescription: String? {
        switch self {
        case .invalidPreference: "The Dock's hiding preference is not a Boolean. It was left unchanged."
        case .synchronizationFailed: "The Dock's hiding preference could not be synchronized."
        case .verificationFailed: "The Dock's hiding preference changed during this operation."
        case .invalidReceipt: "The Dock visibility recovery receipt is invalid or changed. It was preserved."
        }
    }
}

@MainActor
struct DockVisibilityPreferences {
    var read: () throws -> Bool?
    var write: (Bool?) throws -> Void
    var synchronize: () throws -> Void

    static var live: Self {
        let domain = "com.apple.dock" as CFString
        let key = "autohide" as CFString
        return Self(read: {
            guard let value = CFPreferencesCopyValue(key, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) else { return nil }
            guard CFGetTypeID(value) == CFBooleanGetTypeID() else { throw DockVisibilityError.invalidPreference }
            return (value as! NSNumber).boolValue
        }, write: { value in
            CFPreferencesSetValue(key, value.map { $0 ? kCFBooleanTrue : kCFBooleanFalse } ?? nil,
                                  domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        }, synchronize: {
            guard CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) else {
                throw DockVisibilityError.synchronizationFailed
            }
        })
    }
}

@MainActor
struct DockVisibilityScheduler {
    typealias Action = @MainActor @Sendable () -> Void
    typealias Cancellation = @MainActor () -> Void
    var now: () -> Date
    var schedule: (Date, @escaping Action) -> Cancellation

    static var live: Self {
        Self(now: Date.init, schedule: { deadline, action in
            let timer = Timer(fire: deadline, interval: 0, repeats: false) { _ in
                MainActor.assumeIsolated { action() }
            }
            // A default-mode scheduledTimer pauses during AppKit drag tracking.
            // https://developer.apple.com/documentation/foundation/runloop/mode/eventtracking
            RunLoop.main.add(timer, forMode: .common)
            RunLoop.main.add(timer, forMode: .eventTracking)
            return { timer.invalidate() }
        })
    }
}

private struct DockVisibilityReceipt: Codable {
    let version: Int
    let owner: String
    let userID: UInt32
    let domain: String
    let key: String
    let id: UUID
    let originalAutohide: Bool
    let temporaryAutohide: Bool
    let createdAt: Date
    var state: String

    init(now: Date) {
        version = 1; owner = "dev.extensions-anywhere.app"; userID = getuid()
        domain = "com.apple.dock"; key = "autohide"; id = UUID()
        originalAutohide = true; temporaryAutohide = false; createdAt = now; state = "prepared"
    }

    var valid: Bool {
        version == 1 && owner == "dev.extensions-anywhere.app" && userID == getuid() &&
        domain == "com.apple.dock" && key == "autohide" && originalAutohide && !temporaryAutohide &&
        ["prepared", "active", "restoring"].contains(state) && createdAt.timeIntervalSince1970.isFinite
    }
}

/// Temporarily changes only an explicitly enabled Dock autohide preference.
/// Dock's preference key and process refresh remain undocumented integrations;
/// CFPreferences synchronization persists values, but does not promise a live
/// Dock reload. No guessed distributed notification is posted.
@MainActor
@Observable
final class DockVisibilityManager {
    private let receiptURL: URL
    private let preferences: DockVisibilityPreferences
    private let scheduler: DockVisibilityScheduler
    private let refreshDock: () throws -> Void
    private let onError: (Error) -> Void
    private var ownedReceipt: DockVisibilityReceipt?
    private var cancelTimer: DockVisibilityScheduler.Cancellation?
    private var isPresenting = false
    private var pickedUp = false
    private(set) var restoreDeadline: Date?
    private(set) var lastError: String?
    var isTemporarilyVisible: Bool { ownedReceipt != nil }

    static var defaultReceiptURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Extensions Anywhere/DockVisibility/receipt.json")
    }

    convenience init(receiptURL: URL = defaultReceiptURL, onError: @escaping (Error) -> Void = { _ in }) {
        self.init(receiptURL: receiptURL, preferences: .live, scheduler: .live,
                  refreshDock: DockShortcutManager.restartDock, onError: onError)
    }

    init(receiptURL: URL, preferences: DockVisibilityPreferences, scheduler: DockVisibilityScheduler,
         refreshDock: @escaping () throws -> Void, onError: @escaping (Error) -> Void = { _ in }) {
        self.receiptURL = receiptURL
        self.preferences = preferences; self.scheduler = scheduler
        self.refreshDock = refreshDock; self.onError = onError
    }

    /// Call on presentation and on window movement before the icon is picked up.
    /// Repeated calls never extend a running restoration deadline.
    func beginPresentation() throws {
        if isPresenting || restoreDeadline != nil {
            isPresenting = true
            if !pickedUp, ownedReceipt != nil, try currentValue() != false { try relinquishReceipt() }
            return
        }
        try recoverIfNeeded()
        isPresenting = true; pickedUp = false; lastError = nil
        // An absent preference is deliberately not interpreted as a default.
        guard try currentValue() == true else { return }
        var receipt = DockVisibilityReceipt(now: scheduler.now())
        try save(receipt)
        ownedReceipt = receipt
        do {
            guard try currentValue() == true else { try relinquishReceipt(); return }
            try preferences.write(false)
            guard try currentValue() == false else { throw DockVisibilityError.verificationFailed }
            receipt.state = "active"
            try save(receipt); ownedReceipt = receipt
            // This occurs before beginDraggingSession, never during pickup.
            try refreshDock()
        } catch {
            try? restoreOwnedPreference()
            throw error
        }
    }

    /// Call at drag start, not at drag completion. Repeated drags reset 10 seconds.
    func dragBegan() throws {
        guard isPresenting else { return }
        pickedUp = true
        guard let receipt = ownedReceipt else { return }
        guard let persisted = try load(), persisted.id == receipt.id else { throw DockVisibilityError.invalidReceipt }
        guard try currentValue() == false else { try relinquishReceipt(); return }
        restoreDeadline = scheduler.now().addingTimeInterval(10)
        scheduleRestoration()
    }

    func endPresentation() throws {
        isPresenting = false
        pickedUp = false
        // Dismissal ends the visibility lease immediately, including after pickup.
        // restoreOwnedPreference also cancels any pending ten-second timer.
        try restoreOwnedPreference()
    }

    func restoreOnTermination() throws {
        isPresenting = false
        try restoreOwnedPreference()
    }

    /// Call once at app startup, before showing a new drag window.
    func recoverIfNeeded() throws {
        guard ownedReceipt == nil, restoreDeadline == nil else { return }
        guard let receipt = try load() else { return }
        ownedReceipt = receipt
        try restoreOwnedPreference()
    }

    private func scheduleRestoration() {
        cancelTimer?()
        guard let deadline = restoreDeadline else { return }
        cancelTimer = scheduler.schedule(deadline) { [weak self] in
            guard let self, let currentDeadline = self.restoreDeadline else { return }
            if self.scheduler.now() < currentDeadline { self.scheduleRestoration(); return }
            do { try self.restoreOwnedPreference() }
            catch { self.lastError = error.localizedDescription; self.onError(error) }
        }
    }

    private func restoreOwnedPreference() throws {
        cancelTimer?(); cancelTimer = nil; restoreDeadline = nil
        guard var receipt = try load() else {
            if ownedReceipt != nil { throw DockVisibilityError.invalidReceipt }
            return
        }
        guard ownedReceipt == nil || ownedReceipt?.id == receipt.id else { throw DockVisibilityError.invalidReceipt }
        ownedReceipt = receipt
        let current = try currentValue()
        guard current == false else {
            // A interrupted restore may have written the original value already.
            if receipt.state == "restoring", current == receipt.originalAutohide { try refreshDock() }
            try relinquishReceipt()
            return
        }
        receipt.state = "restoring"
        try save(receipt); ownedReceipt = receipt
        // Conditional read-back avoids overwriting observable external changes.
        guard try currentValue() == false else { try relinquishReceipt(); return }
        try preferences.write(receipt.originalAutohide)
        guard try currentValue() == receipt.originalAutohide else { throw DockVisibilityError.verificationFailed }
        // Exact 10-second restoration may restart Dock during a long drag.
        try refreshDock()
        try relinquishReceipt()
    }

    private func currentValue() throws -> Bool? {
        try preferences.synchronize()
        return try preferences.read()
    }

    private func relinquishReceipt() throws {
        if let persisted = try load() {
            guard let ownedReceipt, persisted.id == ownedReceipt.id else { throw DockVisibilityError.invalidReceipt }
            try FileManager.default.removeItem(at: receiptURL)
        } else if ownedReceipt != nil { throw DockVisibilityError.invalidReceipt }
        ownedReceipt = nil
        cancelTimer?(); cancelTimer = nil; restoreDeadline = nil
    }

    private func load() throws -> DockVisibilityReceipt? {
        let attributes: [FileAttributeKey: Any]
        do { attributes = try FileManager.default.attributesOfItem(atPath: receiptURL.path) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              let size = attributes[.size] as? NSNumber, size.intValue <= 4096 else { throw DockVisibilityError.invalidReceipt }
        let data = try Data(contentsOf: receiptURL)
        guard data.count <= 4096, let receipt = try? JSONDecoder().decode(DockVisibilityReceipt.self, from: data), receipt.valid else {
            throw DockVisibilityError.invalidReceipt
        }
        return receipt
    }

    private func save(_ receipt: DockVisibilityReceipt) throws {
        guard receipt.valid else { throw DockVisibilityError.invalidReceipt }
        if let existing = try load(), existing.id != receipt.id { throw DockVisibilityError.invalidReceipt }
        try FileManager.default.createDirectory(at: receiptURL.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(receipt).write(to: receiptURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: receiptURL.path)
    }
}
