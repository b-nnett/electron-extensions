// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ExtensionsAnywhere",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "ExtensionsAnywhere", targets: ["ExtensionsAnywhere"]),
        .executable(name: "ExtensionLauncher", targets: ["ExtensionLauncher"]),
        .executable(name: "CatalogAppLaunch", targets: ["CatalogAppLaunch"]),
        .executable(name: "ProcessIdentity", targets: ["ProcessIdentity"])
    ],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.9.6")
    ],
    targets: [
        .target(name: "RuntimeCatalog", path: "Shared"),
        .executableTarget(
            name: "ExtensionsAnywhere",
            dependencies: ["RuntimeCatalog", .product(name: "Sparkle", package: "Sparkle")],
            path: "Sources",
            linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
        ),
        .executableTarget(name: "ExtensionLauncher", dependencies: ["RuntimeCatalog"], path: "Launcher"),
        .executableTarget(name: "CatalogAppLaunch", dependencies: ["RuntimeCatalog"], path: "CatalogLaunch"),
        .executableTarget(name: "ProcessIdentity", dependencies: ["RuntimeCatalog"], path: "ProcessIdentity"),
        .testTarget(
            name: "ExtensionsAnywhereTests",
            dependencies: ["ExtensionsAnywhere", "RuntimeCatalog"],
            path: "Tests"
        )
    ]
)
