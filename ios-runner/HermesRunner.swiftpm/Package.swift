// swift-tools-version: 5.8
import PackageDescription

let package = Package(
    name: "HermesRunner",
    platforms: [
        .iOS("16.0"),
        .macOS("13.0")
    ],
    products: [
        .iOSApplication(
            name: "HermesRunner",
            targets: ["AppModule"],
            bundleIdentifier: "com.automati.hermesrunner",
            displayVersion: "1.0",
            bundleVersion: "1",
            appIcon: .placeholder(icon: .robot),
            accentColor: .presetColor(.blue),
            supportedDeviceFamilies: [
                .pad,
                .phone
            ],
            supportedInterfaceOrientations: [
                .portrait,
                .landscapeRight,
                .landscapeLeft,
                .portraitUpsideDown(.when(deviceFamilies: [.pad]))
            ],
            appCategory: .utilities
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: "App"
        )
    ]
)
