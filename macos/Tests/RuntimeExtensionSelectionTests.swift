import Foundation
import RuntimeCatalog
import XCTest

final class RuntimeExtensionSelectionTests: XCTestCase {
    private typealias Selection = RuntimeExtensionSelection
    private typealias Record = RuntimeExtensionSelection.Record
    private typealias Source = RuntimeExtensionSelection.Source
    private let target = RuntimeExtensionSelection.styleLabIdentifier

    private func record(_ files: [Source], id: String = UUID().uuidString, appKey: String? = nil,
                        enabled: Bool = true, package: Bool = true, legacyName: String? = nil,
                        legacyType: String? = nil, legacyText: String? = nil) -> Record {
        let first = files.first ?? Source(fileName: "main.js", type: "js", text: "")
        return Record(id: id, appKey: appKey ?? target, name: "Example", isEnabled: enabled,
            sourceFileName: legacyName ?? (first.fileName as NSString).lastPathComponent,
            sourceType: legacyType ?? first.type, sourceText: legacyText ?? first.text,
            sourceFiles: package ? files : nil)
    }

    private func select(_ records: [Record], policy: Selection.Policy = .styleLabMixed) throws -> Selection.Selection {
        try Selection.select(records: records, targetIdentifier: target, policy: policy)
    }

    private func error(_ expected: Selection.ValidationError, _ operation: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try operation(), file: file, line: line) { value in
            XCTAssertEqual(value as? Selection.ValidationError, expected, file: file, line: line)
        }
    }

    func testJSOnlyAndMixedFixtureSelectionsHaveOrderedFilesAndContent() throws {
        let js = Source(fileName: "scripts/main.JS", type: "js", text: "console.log('🙂')")
        let only = try select([record([js])])
        XCTAssertTrue(only.hasContent); XCTAssertEqual(only.css, ""); XCTAssertEqual(only.cssBytes, 0)
        XCTAssertEqual(only.javaScriptBytes, js.text.utf8.count)
        let files = [Source(fileName: "styles/base.css", type: "css", text: "button {}"), js]
        let mixed = try select([record(files)])
        XCTAssertEqual(mixed.records.first?.files, files)
        XCTAssertEqual(mixed.css, "button {}"); XCTAssertEqual(mixed.enabledExtensionIDs.count, 1)
    }

    func testCSSOnlyPolicyStillRejectsMixedAndJSOnlyEvenForStoredFixtureID() throws {
        let script = record([Source(fileName: "main.js", type: "js", text: "console.log(1)")])
        error(.unsupportedJavaScript) { _ = try select([script], policy: .cssOnly) }
        let mixed = record([Source(fileName: "main.css", type: "css", text: "button {}"), Source(fileName: "main.js", type: "js", text: "console.log(1)")])
        error(.unsupportedJavaScript) { _ = try select([mixed], policy: .cssOnly) }
        error(.wrongMixedTarget) {
            _ = try Selection.select(records: [], targetIdentifier: "com.openai.codex", policy: .styleLabMixed)
        }
    }

    func testCSSLimitCountsUTF8AndSeparatorsAcrossRecordsWhileJSHasNoJoins() throws {
        let fullCSS = record([Source(fileName: "full.css", type: "css", text: String(repeating: "é", count: 32768))])
        XCTAssertEqual(try select([fullCSS]).cssBytes, 65536)
        error(.cssTooLarge) { _ = try select([fullCSS, record([Source(fileName: "empty.css", type: "css", text: "")])]) }
        let half = String(repeating: "🙂", count: 32768)
        let js = record([Source(fileName: "one.js", type: "js", text: half), Source(fileName: "two.js", type: "js", text: half)])
        XCTAssertEqual(try select([js]).javaScriptBytes, 262144)
        error(.javaScriptTooLarge) { _ = try select([js, record([Source(fileName: "extra.js", type: "js", text: "a")])]) }
    }

    func testRecordAndPerRecordFileLimitsAreIndependent() throws {
        let many = (0..<64).map { index in record([Source(fileName: "\(index).js", type: "js", text: "0")]) }
        XCTAssertEqual(try select(many).records.count, 64)
        error(.tooManyRecords) { _ = try select(many + [record([Source(fileName: "extra.js", type: "js", text: "0")])]) }
        let files = (0..<32).map { Source(fileName: "\($0).js", type: "js", text: "0") }
        XCTAssertEqual(try select([record(files)]).records.first?.files.count, 32)
        error(.tooManyFiles) { _ = try select([record(files + [Source(fileName: "extra.js", type: "js", text: "0")])]) }
    }

    func testUUIDUniquenessIsCaseInsensitiveAndDisabledOrForeignSourcesDoNotExecute() throws {
        let uuid = UUID().uuidString
        let files = [Source(fileName: "main.js", type: "js", text: "console.log(1)")]
        error(.invalidRecord) { _ = try select([record(files, id: uuid), record(files, id: uuid.lowercased())]) }
        error(.invalidRecord) { _ = try select([record(files, id: "not-a-uuid")]) }
        let records = [record(files), record(files, enabled: false), record(files, appKey: "unrelated.app")]
        XCTAssertEqual(try select(records).records.count, 1)
        XCTAssertFalse(try select([record(files, enabled: false)]).hasContent)
    }

    func testLegacyFirstSourceMustMatchPackageBasenameTypeAndExactText() throws {
        let files = [Source(fileName: "scripts/main.js", type: "js", text: "console.log(1)")]
        XCTAssertNoThrow(try select([record(files)]))
        error(.inconsistentFirstSource) { _ = try select([record(files, legacyName: "scripts/main.js")]) }
        error(.inconsistentFirstSource) { _ = try select([record(files, legacyType: "css")]) }
        error(.inconsistentFirstSource) { _ = try select([record(files, legacyText: "different")]) }
        XCTAssertTrue(try select([record([Source(fileName: "main.js", type: "js", text: "0")], package: false)]).hasContent)
    }

    func testNamesAreBoundedLabelsAndNeverInterpretedAsExternalSourcePaths() throws {
        for name in ["../main.js", "/main.js", "scripts//main.js", "scripts/./main.js", "scripts\\main.js", "https:main.js", "main\n.js", String(repeating: "é", count: 127) + ".js"] {
            error(.invalidSource) { _ = try select([record([Source(fileName: name, type: "js", text: "0")])]) }
        }
        let valid = String(repeating: "a", count: 253) + ".js"
        XCTAssertEqual(valid.utf8.count, 256)
        XCTAssertNoThrow(try select([record([Source(fileName: valid, type: "js", text: "0")])]))
        error(.invalidSource) { _ = try select([record([Source(fileName: "main.js", type: "css", text: "0")])]) }
        error(.invalidSource) { _ = try select([record([Source(fileName: "main.js", type: "js", text: "0"), Source(fileName: "main.js", type: "js", text: "1")])]) }
    }

    func testEmptyEnabledAggregateIsRejectedButEmptyCompanionRecordsAreAllowed() throws {
        error(.emptyMixedSources) { _ = try select([record([Source(fileName: "main.js", type: "js", text: " \n\t")])]) }
        error(.emptyCSS) { _ = try select([record([Source(fileName: "main.css", type: "css", text: " \n")])], policy: .cssOnly) }
        let result = try select([record([Source(fileName: "empty.css", type: "css", text: "")]), record([Source(fileName: "main.js", type: "js", text: "0")])])
        XCTAssertTrue(result.hasContent); XCTAssertEqual(result.records.count, 2)
        XCTAssertFalse(try select([]).hasContent)
    }

    func testNativeLibraryDecodeUsesTheSameSelectionRulesAndRejectsBadSchemaAndTypes() throws {
        let source = record([Source(fileName: "scripts/main.js", type: "js", text: "console.log(1)")])
        let data = try JSONEncoder().encode(["records": [source]])
        let direct = try select([source])
        let decoded = try Selection.decodeLibrary(data, targetIdentifier: target, policy: .styleLabMixed)
        XCTAssertEqual(decoded.javaScriptBytes, direct.javaScriptBytes)
        XCTAssertEqual(decoded.enabledExtensionIDs, direct.enabledExtensionIDs)
        XCTAssertEqual(decoded.records.first?.files, direct.records.first?.files)
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        json["schemaVersion"] = 2
        error(.invalidLibrary) { _ = try Selection.decodeLibrary(JSONSerialization.data(withJSONObject: json), targetIdentifier: target, policy: .styleLabMixed) }
        json["schemaVersion"] = 1
        var records = try XCTUnwrap(json["records"] as? [[String: Any]])
        records[0]["isEnabled"] = 1
        json["records"] = records
        error(.invalidLibrary) { _ = try Selection.decodeLibrary(JSONSerialization.data(withJSONObject: json), targetIdentifier: target, policy: .styleLabMixed) }
    }

    func testCatalogMixedPolicyRequiresTheExactReviewedVSCodeProfile() throws {
        let entry = try XCTUnwrap(RuntimeAppCatalog.entries.first { $0.slug == "vscode" })
        XCTAssertEqual(Selection.catalogPolicy(for: entry), .catalogMixed(targetIdentifier: entry.bundleIdentifier))
        let original = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(entry)) as? [String: Any])
        func policy(changing key: String, to value: Any) throws -> Selection.Policy {
            var changed = original
            changed[key] = value
            let entry = try JSONDecoder().decode(RuntimeAppDefinition.self, from: JSONSerialization.data(withJSONObject: changed))
            return Selection.catalogPolicy(for: entry)
        }
        for (key, value) in [
            ("slug", "cursor"), ("name", "VS Code copy"), ("bundleIdentifier", "com.example.VSCode"),
            ("bundlePath", "/Applications/VS Code Copy.app"),
            ("executable", "/Applications/Visual Studio Code.app/Contents/MacOS/Other"), ("transport", "pipe")
        ] {
            XCTAssertEqual(try policy(changing: key, to: value), .cssOnly, key)
        }
        XCTAssertEqual(try policy(changing: "arguments", to: ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"]), .catalogMixed(targetIdentifier: entry.bundleIdentifier))
        XCTAssertEqual(try policy(changing: "arguments", to: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"]), .catalogMixed(targetIdentifier: entry.bundleIdentifier))
        XCTAssertEqual(try policy(changing: "arguments", to: ["--remote-debugging-port=0", "--remote-debugging-port=0"]), .cssOnly)
        XCTAssertEqual(try policy(changing: "arguments", to: ["--disable-web-security"]), .cssOnly)
        XCTAssertEqual(try policy(changing: "target", to: ["urlPattern": "^https://example.com/$", "selector": entry.target.selector]), .cssOnly)
        XCTAssertEqual(try policy(changing: "target", to: ["urlPattern": entry.target.urlPattern, "selector": "button"]), .cssOnly)
        XCTAssertEqual(try policy(changing: "ownedLocalService", to: ["executableRelativePath": "Contents/Resources/service"]), .cssOnly)
        for other in RuntimeAppCatalog.entries where !["vscode", "figma"].contains(other.slug) {
            XCTAssertEqual(Selection.catalogPolicy(for: other), .catalogMixed(targetIdentifier: other.bundleIdentifier), other.slug)
        }
    }

    func testVSCodeMixedSelectionAndHelperDecodeUseTheSameLimits() throws {
        let appKey = Selection.visualStudioCodeIdentifier
        let files = [Source(fileName: "styles/main.css", type: "css", text: "button {}"),
                     Source(fileName: "scripts/main.js", type: "js", text: "console.log(1)")]
        let selected = record(files, appKey: appKey)
        let direct = try Selection.select(records: [selected], targetIdentifier: appKey, policy: .catalogMixed(targetIdentifier: appKey))
        let decoded = try Selection.decodeLibrary(JSONEncoder().encode(["records": [selected]]), targetIdentifier: appKey, policy: .catalogMixed(targetIdentifier: appKey))
        XCTAssertEqual(direct.records.first?.files, files)
        XCTAssertEqual(decoded.records.first?.files, files)
        XCTAssertEqual(decoded.enabledExtensionIDs, direct.enabledExtensionIDs)
        let jsOnly = record([Source(fileName: "main.js", type: "js", text: "0")], appKey: appKey)
        XCTAssertTrue(try Selection.select(records: [jsOnly], targetIdentifier: appKey, policy: .catalogMixed(targetIdentifier: appKey)).hasContent)
        error(.javaScriptTooLarge) {
            let large = record([Source(fileName: "main.js", type: "js", text: String(repeating: "x", count: 262145))], appKey: appKey)
            _ = try Selection.select(records: [large], targetIdentifier: appKey, policy: .catalogMixed(targetIdentifier: appKey))
        }
        error(.unsupportedJavaScript) { _ = try Selection.select(records: [jsOnly], targetIdentifier: appKey, policy: .cssOnly) }
        for other in [target, "com.openai.codex", "com.hnc.Discord", "com.example.Figma"] {
            error(.wrongMixedTarget) { _ = try Selection.select(records: [], targetIdentifier: other, policy: .catalogMixed(targetIdentifier: appKey)) }
        }
        error(.wrongMixedTarget) { _ = try Selection.select(records: [], targetIdentifier: appKey, policy: .styleLabMixed) }
    }

    func testFigmaMixedPolicyRequiresExactHTTPSOriginAndOrdinaryPipeArguments() throws {
        let entry = try XCTUnwrap(RuntimeAppCatalog.entries.first { $0.slug == "figma" })
        XCTAssertEqual(entry.target.urlPattern, #"^https://www\.figma\.com/[^?#\r\n]*$"#)
        XCTAssertEqual(Selection.catalogPolicy(for: entry), .catalogMixed(targetIdentifier: entry.bundleIdentifier))
        let original = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(entry)) as? [String: Any])
        func policy(changing key: String, to value: Any) throws -> Selection.Policy {
            var changed = original
            changed[key] = value
            return Selection.catalogPolicy(for: try JSONDecoder().decode(RuntimeAppDefinition.self,
                from: JSONSerialization.data(withJSONObject: changed)))
        }
        for (key, value) in [
            ("slug", "figma-beta"), ("name", "Figma copy"), ("bundleIdentifier", "com.example.Figma"),
            ("bundlePath", "/Applications/Figma Copy.app"),
            ("executable", "/Applications/Figma.app/Contents/MacOS/Other"), ("transport", "tcp")
        ] { XCTAssertEqual(try policy(changing: key, to: value), .cssOnly, key) }
        XCTAssertEqual(try policy(changing: "arguments", to: [] as [String]), .catalogMixed(targetIdentifier: entry.bundleIdentifier))
        XCTAssertEqual(try policy(changing: "arguments", to: ["--remote-debugging-pipe"]), .catalogMixed(targetIdentifier: entry.bundleIdentifier))
        for arguments in [["--remote-debugging-pipe", "--remote-debugging-pipe"], ["--remote-debugging-port=0"], ["--disable-web-security"]] {
            XCTAssertEqual(try policy(changing: "arguments", to: arguments), .cssOnly)
        }
        for route in [#"^https://www\.figma\.com/login/?$"#, #"^https://www\.figma\.com/files/?$"#,
                      #"^https://www\.figma\.com/.*$"#, #"^https://figma\.com/[^?#\r\n]*$"#,
                      #"^http://www\.figma\.com/[^?#\r\n]*$"#, #"^https://www\.figma\.com:443/[^?#\r\n]*$"#,
                      #"^https://user@www\.figma\.com/[^?#\r\n]*$"#, "^file:.*$"] {
            XCTAssertEqual(try policy(changing: "target", to: ["urlPattern": route, "selector": entry.target.selector]), .cssOnly)
        }
        XCTAssertEqual(try policy(changing: "target", to: ["urlPattern": entry.target.urlPattern, "selector": "button"]), .cssOnly)
        XCTAssertEqual(try policy(changing: "ownedLocalService", to: ["executableRelativePath": "Contents/Resources/service"]), .cssOnly)
    }

    func testFigmaNativeSelectionAndPackagedHelperDecodeShareMixedBounds() throws {
        let appKey = Selection.figmaIdentifier
        let sources = [Source(fileName: "style.css", type: "css", text: "button {}"),
                       Source(fileName: "main.js", type: "js", text: "console.log(1)")]
        let selected = record(sources, appKey: appKey)
        let direct = try Selection.select(records: [selected], targetIdentifier: appKey, policy: .catalogMixed(targetIdentifier: appKey))
        let decoded = try Selection.decodeLibrary(JSONEncoder().encode(["records": [selected]]), targetIdentifier: appKey, policy: .catalogMixed(targetIdentifier: appKey))
        XCTAssertEqual(direct.records.first?.files, sources)
        XCTAssertEqual(decoded.records.first?.files, sources)
        XCTAssertEqual(decoded.enabledExtensionIDs, direct.enabledExtensionIDs)
        XCTAssertTrue(try Selection.select(records: [record([sources[1]], appKey: appKey)], targetIdentifier: appKey, policy: .catalogMixed(targetIdentifier: appKey)).hasContent)
        error(.unsupportedJavaScript) { _ = try Selection.select(records: [selected], targetIdentifier: appKey, policy: .cssOnly) }
        error(.javaScriptTooLarge) {
            _ = try Selection.select(records: [record([.init(fileName: "main.js", type: "js",
                text: String(repeating: "x", count: Selection.maximumJavaScriptBytes + 1))], appKey: appKey)],
                targetIdentifier: appKey, policy: .catalogMixed(targetIdentifier: appKey))
        }
    }

    func testGenericCatalogCapabilityIsExplicitValidatedAndBoundToSelectedIdentifier() throws {
        let entries = RuntimeAppCatalog.entries
        XCTAssertEqual(entries.count, 47)
        for entry in entries {
            XCTAssertEqual(entry.rendererRuntime?.engine, "isolated-js-v1", entry.slug)
            XCTAssertEqual(entry.rendererRuntime?.verification, "not-verified", entry.slug)
            let policy = Selection.catalogPolicy(for: entry)
            XCTAssertEqual(policy, .catalogMixed(targetIdentifier: entry.bundleIdentifier), entry.slug)
            let script = record([.init(fileName: "main.js", type: "js", text: "console.log(1)")], appKey: entry.bundleIdentifier)
            XCTAssertTrue(try Selection.select(records: [script], targetIdentifier: entry.bundleIdentifier, policy: policy).hasContent, entry.slug)
            error(.wrongMixedTarget) { _ = try Selection.select(records: [], targetIdentifier: "com.example.other", policy: policy) }
            var original = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(entry)) as? [String: Any])
            original.removeValue(forKey: "rendererRuntime")
            let legacy = try JSONDecoder().decode(RuntimeAppDefinition.self, from: JSONSerialization.data(withJSONObject: original))
            XCTAssertEqual(Selection.catalogPolicy(for: legacy), .cssOnly, entry.slug)
            error(.unsupportedJavaScript) { _ = try Selection.select(records: [script], targetIdentifier: entry.bundleIdentifier, policy: Selection.catalogPolicy(for: legacy)) }
        }
        let entry = try XCTUnwrap(entries.first { $0.slug == "discord" })
        var invalid = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(entry)) as? [String: Any])
        invalid["arguments"] = ["--disable-web-security"]
        let parsed = try JSONDecoder().decode(RuntimeAppDefinition.self, from: JSONSerialization.data(withJSONObject: invalid))
        XCTAssertEqual(Selection.catalogPolicy(for: parsed), .cssOnly)
    }

    func testRendererRuntimeMetadataRejectsMalformedAndVerificationClaims() throws {
        let entry = try XCTUnwrap(RuntimeAppCatalog.entries.first)
        let original = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(entry)) as? [String: Any])
        let invalidMetadata: [Any] = [NSNull(), "isolated-js-v1", ["engine": "isolated-js-v1"],
            ["engine": "isolated-js-v2", "verification": "not-verified"],
            ["engine": "isolated-js-v1", "verification": "verified"],
            ["engine": "isolated-js-v1", "verification": "not-verified", "bypassCSP": true] as [String: Any]]
        for metadata in invalidMetadata {
            var changed = original; changed["rendererRuntime"] = metadata
            XCTAssertThrowsError(try RuntimeAppCatalog.decode(JSONSerialization.data(withJSONObject: [changed])))
        }
    }

    func testChatGPTBuiltInMixedPolicyUsesExactIdentifierAndSharedBounds() throws {
        let appKey = Selection.chatgptIdentifier
        let script = record([.init(fileName: "main.js", type: "js", text: "console.log(1)")], appKey: appKey)
        XCTAssertTrue(try Selection.select(records: [script], targetIdentifier: appKey, policy: .chatgptMixed).hasContent)
        XCTAssertTrue(try Selection.decodeLibrary(JSONEncoder().encode(["records": [script]]), targetIdentifier: appKey, policy: .chatgptMixed).hasContent)
        error(.wrongMixedTarget) { _ = try Selection.select(records: [], targetIdentifier: Selection.styleLabIdentifier, policy: .chatgptMixed) }
        error(.unsupportedJavaScript) { _ = try Selection.select(records: [script], targetIdentifier: appKey, policy: .cssOnly) }
        error(.javaScriptTooLarge) {
            _ = try Selection.select(records: [record([.init(fileName: "main.js", type: "js", text: String(repeating: "x", count: Selection.maximumJavaScriptBytes + 1))], appKey: appKey)], targetIdentifier: appKey, policy: .chatgptMixed)
        }
    }
}
