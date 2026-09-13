import Darwin
import Foundation
import RuntimeCatalog

/// Read-only, bounded process metadata for our broker. Never launches, changes,
/// or signals another process; the shared reader only uses the kill-0 probe.
@main
private struct ProcessIdentityMain {
    static func main() {
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            guard arguments.count == 1, arguments[0].utf8.count <= 128 * 1024 else { throw invalidInput() }
            let pids = try JSONDecoder().decode([Int32].self, from: Data(arguments[0].utf8))
            guard !pids.isEmpty, pids.count <= 8192, pids.allSatisfy({ $0 > 0 }),
                  Set(pids).count == pids.count else { throw invalidInput() }
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            let result = pids.map { RuntimeProcessIdentity.processRecord(processIdentifier: $0) }
            FileHandle.standardOutput.write(try encoder.encode(result) + Data([0x0a]))
        } catch {
            FileHandle.standardError.write(Data("Usage: ProcessIdentity '[pid,...]' (1–8192 unique positive 32-bit PIDs).\n".utf8))
            Darwin.exit(EX_USAGE)
        }
    }

    private static func invalidInput() -> NSError {
        NSError(domain: "ExtensionsAnywhere.ProcessIdentity", code: 1)
    }
}
