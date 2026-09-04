// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "pumpd-native-host",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "pumpd-native-host", targets: ["PumpdNativeHost"])
  ],
  targets: [
    .executableTarget(name: "PumpdNativeHost"),
    .testTarget(name: "PumpdNativeHostTests", dependencies: ["PumpdNativeHost"]),
  ]
)
