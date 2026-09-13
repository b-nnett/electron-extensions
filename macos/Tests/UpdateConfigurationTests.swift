import Foundation
import XCTest
@testable import ExtensionsAnywhere

final class UpdateConfigurationTests: XCTestCase {
    private var valid: [String: Any] { [
        "SUFeedURL": "https://github.com/example/app/releases/latest/download/appcast.xml",
        "SUPublicEDKey": Data(repeating: 12, count: 32).base64EncodedString(),
        "SUVerifyUpdateBeforeExtraction": true, "SURequireSignedFeed": true
    ] }
    func testValidConfiguration() throws { try UpdateConfiguration.validate(valid) }
    func testRejectsMissingSigningKeysAndUnsignedFeeds() {
        for key in valid.keys {
            var info = valid; info.removeValue(forKey: key)
            XCTAssertThrowsError(try UpdateConfiguration.validate(info), key)
        }
        var info = valid; info["SUPublicEDKey"] = Data(repeating: 12, count: 31).base64EncodedString()
        XCTAssertThrowsError(try UpdateConfiguration.validate(info))
        info = valid; info["SURequireSignedFeed"] = false
        XCTAssertThrowsError(try UpdateConfiguration.validate(info))
    }
    func testRejectsInsecureOrCredentialBearingFeed() {
        for url in ["http://example.com/feed.xml", "file:///tmp/feed.xml", "https://user:pass@example.com/feed.xml",
                    "https://example.com/feed.xml?token=secret", "https://example.com/feed.xml#fragment", ""] {
            var info = valid; info["SUFeedURL"] = url
            XCTAssertThrowsError(try UpdateConfiguration.validate(info), url)
        }
    }
}
