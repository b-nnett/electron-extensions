import AppKit
import Foundation

/// Keeps synchronous Launch Services/filesystem work away from the UI. Only
/// immutable bytes cross the queue boundary; NSImage stays on its creating side.
final class AppIconLoader: Sendable {
    typealias Reader = @Sendable (String) -> Data?

    private let queue = DispatchQueue(label: "dev.extensionsanywhere.app-icons", qos: .utility)
    private let reader: Reader

    init(reader: @escaping Reader = AppIconLoader.systemIconData) {
        self.reader = reader
    }

    func data(for path: String) async -> Data? {
        await withCheckedContinuation { continuation in
            queue.async { [reader] in
                continuation.resume(returning: reader(path))
            }
        }
    }

    // Apple explicitly permits icon(forFile:) on any thread:
    // https://developer.apple.com/documentation/appkit/nsworkspace/icon(forfile:)
    // A blocked OS read cannot be cancelled, so callers must ignore stale results.
    private static func systemIconData(for path: String) -> Data? {
        autoreleasepool {
            NSWorkspace.shared.icon(forFile: path).tiffRepresentation.map { Data($0) }
        }
    }
}
