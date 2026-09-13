#!/usr/bin/env python3
"""Prepare (never launch) a local harness and a signature-preserving build-2 copy."""
from pathlib import Path
import os
import plistlib
import subprocess

REPO = Path(__file__).absolute().parents[2]
OUTPUT = REPO / "output/release-review/2026-09-13/updater-install-test"
BASELINE = REPO / "output/release-review/2026-09-13/notarization/build-2/Extensions Anywhere.app"
EXPECTED = REPO / "output/release-review/2026-09-13/notarization/build-3/Extensions Anywhere.app"
APP = OUTPUT / "Sparkle Install Harness.app"
HOST = OUTPUT / "Host/Extensions Anywhere.app"
FRAMEWORK = REPO / "macos/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework"


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True)


def main():
    for path in (REPO, BASELINE, EXPECTED, OUTPUT, APP, HOST):
        if path.resolve() != path:
            raise SystemExit(f"Refusing a symlinked path: {path}")
    for path, build in ((BASELINE, "2"), (EXPECTED, "3")):
        with (path / "Contents/Info.plist").open("rb") as stream:
            info = plistlib.load(stream)
        if info.get("CFBundleIdentifier") != "dev.extensions-anywhere.app" or info.get("CFBundleVersion") != build:
            raise SystemExit("Unexpected signed build identity")
        run("/usr/bin/codesign", "--verify", "--deep", "--strict", path)
    for owned in (APP, HOST, OUTPUT / "state.json", OUTPUT / "sparkle-preferences-before.plist"):
        if owned.exists():
            raise SystemExit(f"Refusing to overwrite an existing installer test: {owned}")
    OUTPUT.mkdir(parents=True, mode=0o700, exist_ok=True)
    (HOST.parent).mkdir(mode=0o700)
    run("/usr/bin/ditto", BASELINE, HOST)
    run("/usr/bin/codesign", "--verify", "--deep", "--strict", HOST)
    macos = APP / "Contents/MacOS"
    macos.mkdir(parents=True)
    frameworks = APP / "Contents/Frameworks"
    frameworks.mkdir()
    # Only the disposable harness is ad-hoc signed. Host and baseline are untouched.
    run("/usr/bin/ditto", FRAMEWORK, frameworks / "Sparkle.framework")
    info = {"CFBundleIdentifier": "dev.extensions-anywhere.sparkle-install-harness",
            "CFBundleName": "Sparkle Install Harness", "CFBundleExecutable": "SparkleInstallHarness",
            "CFBundlePackageType": "APPL", "CFBundleVersion": "1", "CFBundleShortVersionString": "1.0",
            "NSPrincipalClass": "NSApplication", "LSMinimumSystemVersion": "14.0",
            "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True}}
    with (APP / "Contents/Info.plist").open("wb") as stream:
        plistlib.dump(info, stream)
    run("/usr/bin/xcrun", "swiftc", "-swift-version", "5", "-target", "arm64-apple-macos14.0",
        "-F", FRAMEWORK.parent, "-framework", "Sparkle", "-framework", "AppKit", "-framework", "Security",
        "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
        REPO / "scripts/testing/SparkleInstallHarness.swift", "-o", macos / "SparkleInstallHarness")
    run("/usr/bin/codesign", "--force", "--sign", "-", APP)
    run("/usr/bin/codesign", "--verify", "--deep", "--strict", APP)
    print(f"Prepared but NOT launched: {APP}")
    print("Loopback feed: http://127.0.0.1:8767/appcast.xml")
    print(f"Target copy: {HOST}")


if __name__ == "__main__":
    main()
