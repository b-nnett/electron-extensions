import Foundation
import XCTest
@testable import ExtensionsAnywhere

final class RestartPromptPolicyTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_700_000_000)
    private func instance(pid: Int32 = 123, name: String = "ChatGPT") -> RunningTweakInstance {
        let url = URL(fileURLWithPath: "/Applications/\(name).app")
        return .init(app: .init(id: url.path, name: name, bundleIdentifier: "test.\(name)", url: url),
                     processIdentifier: pid, launchDate: start.addingTimeInterval(Double(pid)))
    }
    private func observation(_ instance: RunningTweakInstance, connected: Bool = false) -> RestartPromptPolicy.Observation {
        .init(instance: instance, connectedOrStarting: connected)
    }

    func testWaitsForUninterruptedGraceAndHealthySessionResetsIt() {
        var policy = RestartPromptPolicy(gracePeriod: 45)
        let app = instance()
        XCTAssertNil(policy.next(observations: [observation(app)], enabled: true, now: start))
        XCTAssertNil(policy.next(observations: [observation(app)], enabled: true, now: start.addingTimeInterval(44)))
        XCTAssertNil(policy.next(observations: [observation(app, connected: true)], enabled: true, now: start.addingTimeInterval(45)))
        XCTAssertNil(policy.next(observations: [observation(app)], enabled: true, now: start.addingTimeInterval(50)))
        XCTAssertNil(policy.next(observations: [observation(app)], enabled: true, now: start.addingTimeInterval(94)))
        XCTAssertEqual(policy.next(observations: [observation(app)], enabled: true, now: start.addingTimeInterval(95)), app)
    }

    func testNotNowDoesNotRepeatForSameProcessButUpdaterReplacementCanPrompt() {
        var policy = RestartPromptPolicy(gracePeriod: 1)
        let old = instance(), new = instance(pid: 456)
        _ = policy.next(observations: [observation(old)], enabled: true, now: start)
        XCTAssertEqual(policy.next(observations: [observation(old)], enabled: true, now: start.addingTimeInterval(1)), old)
        policy.didPresent(old)
        XCTAssertNil(policy.next(observations: [observation(old)], enabled: true, now: start.addingTimeInterval(200)))
        XCTAssertNil(policy.next(observations: [observation(new)], enabled: true, now: start.addingTimeInterval(201)))
        XCTAssertEqual(policy.next(observations: [observation(new)], enabled: true, now: start.addingTimeInterval(202)), new)
    }

    func testTurningPreferenceOffClearsPendingPromptsAndRestartsGraceWhenEnabled() {
        var policy = RestartPromptPolicy(gracePeriod: 5)
        let app = instance()
        _ = policy.next(observations: [observation(app)], enabled: true, now: start)
        XCTAssertNil(policy.next(observations: [observation(app)], enabled: false, now: start.addingTimeInterval(6)))
        XCTAssertNil(policy.next(observations: [observation(app)], enabled: true, now: start.addingTimeInterval(7)))
        XCTAssertEqual(policy.next(observations: [observation(app)], enabled: true, now: start.addingTimeInterval(12)), app)
    }

    func testRemovedOrDisabledAppsCannotProduceAQueuedPrompt() {
        var policy = RestartPromptPolicy(gracePeriod: 5)
        let app = instance()
        _ = policy.next(observations: [observation(app)], enabled: true, now: start)
        XCTAssertNil(policy.next(observations: [], enabled: true, now: start.addingTimeInterval(6)))
        XCTAssertNil(policy.next(observations: [observation(app)], enabled: true, now: start.addingTimeInterval(7)))
    }

    func testMultipleDisconnectedAppsAreOfferedOneAtATime() {
        var policy = RestartPromptPolicy(gracePeriod: 5)
        let first = instance(), second = instance(pid: 456, name: "Style Lab")
        let observations = [observation(first), observation(second)]
        _ = policy.next(observations: observations, enabled: true, now: start)
        XCTAssertEqual(policy.next(observations: observations, enabled: true, now: start.addingTimeInterval(5)), first)
        policy.didPresent(first)
        XCTAssertEqual(policy.next(observations: observations, enabled: true, now: start.addingTimeInterval(5)), second)
    }
}
