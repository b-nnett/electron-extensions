import Foundation
import XCTest
@testable import ExtensionsAnywhere

final class AppLibraryTests: XCTestCase {
    private func withDirectory(_ body: (URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ExtensionsAnywhere-AppLibraryTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try body(directory)
    }

    @discardableResult
    private func makeApp(
        at url: URL, name: String, identifier: String? = nil, electron: Bool = true,
        executable: String? = nil
    ) throws -> URL {
        let contents = url.appendingPathComponent("Contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        var plist: [String: String] = ["CFBundleName": name, "CFBundlePackageType": "APPL"]
        if let identifier { plist["CFBundleIdentifier"] = identifier }
        if let executable { plist["CFBundleExecutable"] = executable }
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"))
        if electron {
            try FileManager.default.createDirectory(
                at: contents.appendingPathComponent("Frameworks/Electron Framework.framework"),
                withIntermediateDirectories: true
            )
        }
        return url
    }

    func testNestedDiscoveryDeduplicatesAppSymlinksAndSkipsHelpers() throws {
        try withDirectory { root in
            let alpha = try makeApp(at: root.appendingPathComponent("Suite/Alpha.app"), name: "Alpha", identifier: "test.alpha")
            try makeApp(at: root.appendingPathComponent("Zulu.app"), name: "Internal Bundle Name", identifier: "test.zulu")
            try makeApp(at: root.appendingPathComponent("Native.app"), name: "Native", electron: false)
            try makeApp(at: root.appendingPathComponent("Native.app/Contents/Helper.app"), name: "Hidden helper")
            try makeApp(at: alpha.appendingPathComponent("Contents/Helper.app"), name: "Another helper")
            try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("Alpha Alias.app"), withDestinationURL: alpha)

            let apps = try ElectronAppDiscovery.scan(in: root)
            XCTAssertEqual(apps.map(\.name), ["Alpha", "Zulu"])
            XCTAssertEqual(apps.first?.bundleIdentifier, "test.alpha")
            XCTAssertEqual(apps.first?.id, alpha.resolvingSymlinksInPath().path)
            XCTAssertEqual(apps.first?.url.path, apps.first?.id)
        }
    }

    func testFrameworkMustBeContainedAndDirectorySymlinksAreNotFollowed() throws {
        try withDirectory { root in
            let apps = root.appendingPathComponent("Applications")
            try FileManager.default.createDirectory(at: apps, withIntermediateDirectories: true)
            let external = try makeApp(at: root.appendingPathComponent("Elsewhere/External.app"), name: "External")
            let linked = try makeApp(at: apps.appendingPathComponent("Linked.app"), name: "Linked", electron: false)
            let frameworks = linked.appendingPathComponent("Contents/Frameworks")
            try FileManager.default.createDirectory(at: frameworks, withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(
                at: frameworks.appendingPathComponent("Electron Framework.framework"),
                withDestinationURL: external.appendingPathComponent("Contents/Frameworks/Electron Framework.framework")
            )
            try FileManager.default.createSymbolicLink(at: apps.appendingPathComponent("Folder Alias"), withDestinationURL: external.deletingLastPathComponent())
            XCTAssertTrue(try ElectronAppDiscovery.scan(in: apps).isEmpty)
        }
    }

    func testMissingBundleIdentifierIsNotInventedAndInvalidRootThrows() throws {
        try withDirectory { root in
            try makeApp(at: root.appendingPathComponent("UnnamedID.app"), name: "No identifier")
            XCTAssertNil(try ElectronAppDiscovery.scan(in: root).first?.bundleIdentifier)
            XCTAssertThrowsError(try ElectronAppDiscovery.scan(in: root.appendingPathComponent("Missing")))
        }
    }

    func testKnownChatGPTIdentityWithoutElectronIsIncludedAndDeduplicated() throws {
        try withDirectory { root in
            // A renamed bundle still has the installed app's explicit identity.
            let app = try makeApp(at: root.appendingPathComponent("Renamed Client.app"), name: "ChatGPT",
                                  identifier: "com.openai.codex", electron: false, executable: "ChatGPT")
            try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("ChatGPT Alias.app"), withDestinationURL: app)
            let found = try ElectronAppDiscovery.scan(in: root)
            XCTAssertEqual(found.count, 1)
            XCTAssertEqual(found.first?.bundleIdentifier, "com.openai.codex")
            XCTAssertEqual(found.first?.url, app.standardizedFileURL.resolvingSymlinksInPath())
            XCTAssertEqual(found.first?.name, "Renamed Client")
        }
    }

    func testNativeNameLookalikesAndPartialIdentitiesDoNotGetChatGPTException() throws {
        try withDirectory { root in
            try makeApp(at: root.appendingPathComponent("ChatGPT.app"), name: "ChatGPT",
                        identifier: "test.unrelated", electron: false, executable: "ChatGPT")
            try makeApp(at: root.appendingPathComponent("Partial Identity.app"), name: "ChatGPT",
                        identifier: "com.openai.codex", electron: false, executable: "DifferentExecutable")
            try makeApp(at: root.appendingPathComponent("Other Native.app"), name: "Other Native",
                        identifier: "test.native", electron: false, executable: "Other Native")
            XCTAssertTrue(try ElectronAppDiscovery.scan(in: root).isEmpty)
        }
    }

    func testKnownChatGPTIdentityInsideAnotherAppRemainsExcludedAsHelper() throws {
        try withDirectory { root in
            let parent = try makeApp(at: root.appendingPathComponent("Native.app"), name: "Native", electron: false)
            try makeApp(at: parent.appendingPathComponent("Contents/ChatGPT.app"), name: "ChatGPT",
                        identifier: "com.openai.codex", electron: false, executable: "ChatGPT")
            XCTAssertTrue(try ElectronAppDiscovery.scan(in: root).isEmpty)
        }
    }

    func testAssignmentsUseBareMappingAndOnlyNonemptyConfiguredIDs() throws {
        try withDirectory { root in
            let file = root.appendingPathComponent("extensions.json")
            XCTAssertTrue(try ExtensionAssignments.load(from: file).byBundleIdentifier.isEmpty)
            try Data(#"{"test.configured":["theme"],"test.empty":["","  \n"]}"#.utf8).write(to: file)
            let assignments = try ExtensionAssignments.load(from: file)
            let app: (String?) -> InstalledApp = { id in
                InstalledApp(id: root.path, name: "Example", bundleIdentifier: id, url: root)
            }
            XCTAssertTrue(assignments.hasExtensions(for: app("test.configured")))
            XCTAssertFalse(assignments.hasExtensions(for: app("test.empty")))
            XCTAssertFalse(assignments.hasExtensions(for: app("test.unconfigured")))
            XCTAssertFalse(assignments.hasExtensions(for: app(nil)))
            let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(assignments)) as? [String: [String]]
            XCTAssertEqual(encoded, assignments.byBundleIdentifier)
            try Data(#"{"test.configured":"not-a-list"}"#.utf8).write(to: file)
            XCTAssertThrowsError(try ExtensionAssignments.load(from: file))
        }
    }
}
