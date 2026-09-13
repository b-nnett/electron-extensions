import Darwin
import Foundation
import RuntimeCatalog
import XCTest

final class RuntimeBoundedFileTests: XCTestCase {
    func testInvalidLimitsAreRejectedBeforeOpeningAnAbsentFile() {
        let absent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        XCTAssertThrowsError(try RuntimeBoundedFile.read(absent, maximumBytes: -1))
        XCTAssertThrowsError(try RuntimeBoundedFile.read(absent, maximumBytes: Int.max))
    }

    func testReadsExactBoundAndRejectsOversizeSymlinkAndFIFO() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("data")
        XCTAssertNil(try RuntimeBoundedFile.read(file, maximumBytes: 3))
        try Data("abc".utf8).write(to: file)
        XCTAssertEqual(try RuntimeBoundedFile.read(file, maximumBytes: 3), Data("abc".utf8))
        XCTAssertThrowsError(try RuntimeBoundedFile.read(file, maximumBytes: 2))
        let link = root.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
        XCTAssertThrowsError(try RuntimeBoundedFile.read(link, maximumBytes: 3))
        let fifo = root.appendingPathComponent("fifo")
        XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
        XCTAssertThrowsError(try RuntimeBoundedFile.read(fifo, maximumBytes: 3))
        XCTAssertThrowsError(try RuntimeBoundedFile.read(root, maximumBytes: 3))
    }
}
