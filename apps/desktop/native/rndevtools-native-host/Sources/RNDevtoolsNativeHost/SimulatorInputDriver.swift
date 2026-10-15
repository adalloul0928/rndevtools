import Darwin
import Foundation

/// Drives a Simulator over Indigo HID through SimulatorKit's runtime-only
/// `SimDeviceLegacyHIDClient`, the same transport Simulator.app uses for mouse
/// and keyboard, so the guest cannot tell these touches from a user's.
///
/// Nothing here links against Apple's private frameworks: CoreSimulator and
/// SimulatorKit are `dlopen`ed from the active developer directory and the
/// classes and C builders are resolved by name. If any of that is missing the
/// driver reports `simulator_input_unavailable` with the reason, and the
/// desktop falls back to telling the user what the toolchain lacks.
///
/// Message layouts follow the publicly reverse-engineered Indigo wire format
/// (idb's `Indigo.h`): a single-touch message is 320 bytes with the digitizer
/// contact at 0x30, repeated once at 0xB0; buttons and keys come straight from
/// SimulatorKit's own `IndigoHIDMessageFor*` builders.
final class SimulatorKitInputDriver: SimulatorInputDriving {
  @objc private protocol ServiceContextMessaging {
    @objc(sharedServiceContextForDeveloperDir:error:)
    static func shared(forDeveloperDir dir: String, error: AutoreleasingUnsafeMutablePointer<AnyObject?>?)
      -> AnyObject?
    @objc(defaultDeviceSetWithError:)
    func defaultDeviceSet(error: AutoreleasingUnsafeMutablePointer<AnyObject?>?) -> AnyObject?
  }
  @objc private protocol DeviceSetMessaging {
    @objc var devices: [AnyObject] { get }
  }
  @objc private protocol DeviceMessaging {
    @objc var UDID: UUID { get }
    @objc var state: UInt64 { get }
  }
  @objc private protocol HIDClientMessaging {
    @objc(initWithDevice:error:)
    func initWithDevice(_ device: Any, error: AutoreleasingUnsafeMutablePointer<AnyObject?>?) -> AnyObject?
    @objc(sendWithMessage:freeWhenDone:completionQueue:completion:)
    func send(
      withMessage message: UnsafeMutableRawPointer, freeWhenDone: Bool, completionQueue: DispatchQueue,
      completion: @escaping (Error?) -> Void)
  }

  private typealias ButtonBuilder = @convention(c) (Int32, Int32, Int32) -> UnsafeMutableRawPointer
  private typealias KeyboardBuilder = @convention(c) (Int32, Int32) -> UnsafeMutableRawPointer
  private typealias MouseBuilder = @convention(c) (
    UnsafeMutablePointer<CGPoint>?, UnsafeMutablePointer<CGPoint>?, UInt32, UInt, CGSize, UInt32
  ) -> UnsafeMutableRawPointer

  /// SimDevice.state for a booted device (SimDeviceState enum: 3 = Booted).
  private static let bootedState: UInt64 = 3
  /// The digitizer HID service target the mouse/touch builder addresses.
  private static let touchTarget: UInt32 = 0x32
  /// `ButtonEventTargetHardware`: where home, lock, and volume go.
  private static let hardwareTarget: Int32 = 0x33
  private static let eventDown: Int32 = 1
  private static let eventUp: Int32 = 2
  private static let payloadStride = 0x90
  private static let touchMessageSize = 0x20 + 0x90 + 0x90
  private static let acknowledgementTimeout: DispatchTimeInterval = .seconds(5)

  private let developerDirectory: String
  private let queue = DispatchQueue(label: "dev.rndevtools.native-host.simulator-input")

  init(developerDirectory: String? = nil) {
    self.developerDirectory =
      developerDirectory
      ?? ProcessInfo.processInfo.environment["DEVELOPER_DIR"]
      ?? SimulatorKitInputDriver.activeDeveloperDirectory()
      ?? "/Applications/Xcode.app/Contents/Developer"
  }

  func send(_ request: SimulatorInputRequest, cancellation: any CancellationChecking) throws
    -> SimulatorInputResult
  {
    let started = DispatchTime.now()
    let toolkit = try loadToolkit()
    let device = try bootedDevice(udid: request.udid, toolkit: toolkit)
    let client = try hidClient(for: device)
    var delivered = 0
    let deliver: (UnsafeMutableRawPointer) throws -> Void = { message in
      try cancellation.check()
      try self.deliver(message, through: client)
      delivered += 1
    }

    switch request {
    case let .tap(_, point, hold):
      try deliver(touchMessage(point, down: true, toolkit: toolkit))
      pause(milliseconds: hold)
      try deliver(touchMessage(point, down: false, toolkit: toolkit))
    case let .swipe(_, from, to, duration, steps):
      try deliver(touchMessage(from, down: true, toolkit: toolkit))
      let interval = max(1, duration / steps)
      for step in 1...steps {
        let fraction = Double(step) / Double(steps)
        let point = SimulatorInputRequest.Point(
          x: from.x + (to.x - from.x) * fraction,
          y: from.y + (to.y - from.y) * fraction)
        pause(milliseconds: interval)
        try deliver(touchMessage(point, down: true, toolkit: toolkit))
      }
      pause(milliseconds: 30)
      try deliver(touchMessage(to, down: false, toolkit: toolkit))
    case let .text(_, text):
      for scalar in text.unicodeScalars {
        guard let stroke = KeyboardLayout.stroke(for: scalar) else { continue }
        try typeStroke(stroke, toolkit: toolkit, deliver: deliver)
      }
    case let .key(_, usage, modifiers):
      try typeStroke(
        KeyboardLayout.Stroke(usage: usage, modifiers: modifiers), toolkit: toolkit, deliver: deliver)
    case let .button(_, button):
      try deliver(
        toolkit.messageForButton(button.indigoSource, SimulatorKitInputDriver.eventDown, SimulatorKitInputDriver.hardwareTarget))
      pause(milliseconds: 60)
      try deliver(
        toolkit.messageForButton(button.indigoSource, SimulatorKitInputDriver.eventUp, SimulatorKitInputDriver.hardwareTarget))
    }
    let elapsed = Int((DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000)
    return SimulatorInputResult(
      udid: request.udid, kind: SimulatorKitInputDriver.kindName(request), messages: delivered,
      elapsedMilliseconds: elapsed)
  }

  // MARK: - Toolkit loading

  private struct Toolkit {
    let messageForButton: ButtonBuilder
    let messageForKeyboard: KeyboardBuilder
    let messageForMouse: MouseBuilder
  }

  private func loadToolkit() throws -> Toolkit {
    guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW) != nil
    else {
      throw unavailable("CoreSimulator.framework could not be loaded (\(dlErrorText())).")
    }
    let simulatorKitPath = "\(developerDirectory)/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"
    guard let handle = dlopen(simulatorKitPath, RTLD_NOW) else {
      throw unavailable("SimulatorKit.framework could not be loaded from \(developerDirectory) (\(dlErrorText())).")
    }
    func symbol<T>(_ name: String, as type: T.Type) throws -> T {
      guard let pointer = dlsym(handle, name) else {
        throw unavailable("SimulatorKit does not export \(name) on this Xcode.")
      }
      return unsafeBitCast(pointer, to: type)
    }
    return Toolkit(
      messageForButton: try symbol("IndigoHIDMessageForButton", as: ButtonBuilder.self),
      messageForKeyboard: try symbol("IndigoHIDMessageForKeyboardArbitrary", as: KeyboardBuilder.self),
      messageForMouse: try symbol("IndigoHIDMessageForMouseNSEvent", as: MouseBuilder.self))
  }

  private func bootedDevice(udid: String, toolkit: Toolkit) throws -> AnyObject {
    guard let contextClass = NSClassFromString("SimServiceContext") else {
      throw unavailable("CoreSimulator has no SimServiceContext class.")
    }
    var error: AnyObject?
    guard
      let context = unsafeBitCast(contextClass, to: ServiceContextMessaging.Type.self)
        .shared(forDeveloperDir: developerDirectory, error: &error)
    else {
      throw unavailable("CoreSimulator refused a service context: \(describe(error)).")
    }
    guard let set = unsafeBitCast(context, to: ServiceContextMessaging.self).defaultDeviceSet(error: &error)
    else {
      throw unavailable("CoreSimulator refused the default device set: \(describe(error)).")
    }
    let devices = unsafeBitCast(set, to: DeviceSetMessaging.self).devices
    guard
      let device = devices.first(where: {
        unsafeBitCast($0, to: DeviceMessaging.self).UDID.uuidString.uppercased() == udid.uppercased()
      })
    else {
      throw NativeHostError(code: "simulator_not_found", message: "No Simulator with UDID \(udid) exists.")
    }
    guard unsafeBitCast(device, to: DeviceMessaging.self).state == SimulatorKitInputDriver.bootedState else {
      throw NativeHostError(
        code: "simulator_not_booted", message: "Simulator \(udid) is not booted; input needs a running device.",
        retryable: true)
    }
    return device
  }

  private func hidClient(for device: AnyObject) throws -> AnyObject {
    guard let clientClass = NSClassFromString("SimulatorKit.SimDeviceLegacyHIDClient") else {
      throw unavailable("SimulatorKit has no SimDeviceLegacyHIDClient on this Xcode.")
    }
    guard let allocated = (clientClass as AnyObject).perform(NSSelectorFromString("alloc"))?.takeUnretainedValue()
    else {
      throw unavailable("SimDeviceLegacyHIDClient could not be allocated.")
    }
    var error: AnyObject?
    guard let client = unsafeBitCast(allocated, to: HIDClientMessaging.self).initWithDevice(device, error: &error)
    else {
      throw NativeHostError(
        code: "simulator_input_failed",
        message: "The Simulator refused a HID session: \(describe(error)).", retryable: true)
    }
    return client
  }

  // MARK: - Delivery

  private func deliver(_ message: UnsafeMutableRawPointer, through client: AnyObject) throws {
    let semaphore = DispatchSemaphore(value: 0)
    var failure: Error?
    unsafeBitCast(client, to: HIDClientMessaging.self).send(
      withMessage: message, freeWhenDone: true, completionQueue: queue
    ) { error in
      failure = error
      semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + SimulatorKitInputDriver.acknowledgementTimeout) == .success else {
      throw NativeHostError(
        code: "simulator_input_failed", message: "The Simulator did not acknowledge a HID message within 5s.",
        retryable: true)
    }
    if let failure {
      throw NativeHostError(
        code: "simulator_input_failed", message: "The Simulator rejected a HID message: \(failure).",
        retryable: true)
    }
  }

  private func typeStroke(
    _ stroke: KeyboardLayout.Stroke, toolkit: Toolkit, deliver: (UnsafeMutableRawPointer) throws -> Void
  ) throws {
    for modifier in stroke.modifiers {
      try deliver(toolkit.messageForKeyboard(Int32(modifier.usage), SimulatorKitInputDriver.eventDown))
    }
    try deliver(toolkit.messageForKeyboard(Int32(stroke.usage), SimulatorKitInputDriver.eventDown))
    pause(milliseconds: 12)
    try deliver(toolkit.messageForKeyboard(Int32(stroke.usage), SimulatorKitInputDriver.eventUp))
    for modifier in stroke.modifiers.reversed() {
      try deliver(toolkit.messageForKeyboard(Int32(modifier.usage), SimulatorKitInputDriver.eventUp))
    }
    pause(milliseconds: 8)
  }

  /// A hand-enveloped single-touch Indigo message (eventType 2, 320 bytes). SimulatorKit only
  /// ships a multi-touch builder, so its digitizer contact is copied into a single-touch
  /// envelope and repeated once, marked as the second slot (field1=1, field2=2).
  private func touchMessage(
    _ point: SimulatorInputRequest.Point, down: Bool, toolkit: Toolkit
  ) -> UnsafeMutableRawPointer {
    var cgPoint = CGPoint(x: point.x, y: point.y)
    let source = toolkit.messageForMouse(
      &cgPoint, nil, SimulatorKitInputDriver.touchTarget,
      UInt(down ? SimulatorKitInputDriver.eventDown : SimulatorKitInputDriver.eventUp),
      CGSize(width: 1, height: 1), 0)
    source.storeBytes(of: point.x, toByteOffset: 0x3C, as: Double.self)
    source.storeBytes(of: point.y, toByteOffset: 0x44, as: Double.self)
    let stride = SimulatorKitInputDriver.payloadStride
    guard let message = calloc(1, SimulatorKitInputDriver.touchMessageSize) else {
      fatalError("calloc failed for a 320-byte Indigo message")
    }
    message.storeBytes(of: UInt32(stride), toByteOffset: 0x18, as: UInt32.self)
    message.storeBytes(of: UInt8(2), toByteOffset: 0x1C, as: UInt8.self)
    message.storeBytes(of: UInt32(0x0B), toByteOffset: 0x20, as: UInt32.self)
    message.storeBytes(of: mach_absolute_time(), toByteOffset: 0x24, as: UInt64.self)
    memcpy(message.advanced(by: 0x30), source.advanced(by: 0x30), stride - 0x10)
    free(source)
    memcpy(message.advanced(by: 0x20 + stride), message.advanced(by: 0x20), stride)
    message.storeBytes(of: UInt32(1), toByteOffset: 0x20 + stride + 0x10, as: UInt32.self)
    message.storeBytes(of: UInt32(2), toByteOffset: 0x20 + stride + 0x14, as: UInt32.self)
    return message
  }

  // MARK: - Helpers

  private func pause(milliseconds: Int) {
    if milliseconds > 0 { usleep(useconds_t(min(milliseconds, 10_000) * 1_000)) }
  }

  private func unavailable(_ reason: String) -> NativeHostError {
    NativeHostError(code: "simulator_input_unavailable", message: reason)
  }

  private func describe(_ error: AnyObject?) -> String {
    guard let error else { return "no error details" }
    return (error as? NSError)?.localizedDescription ?? String(describing: error)
  }

  private func dlErrorText() -> String {
    guard let text = dlerror() else { return "unknown dlopen error" }
    return String(cString: text)
  }

  private static func kindName(_ request: SimulatorInputRequest) -> String {
    switch request {
    case .tap: return "tap"
    case .swipe: return "swipe"
    case .text: return "text"
    case .key: return "key"
    case .button: return "button"
    }
  }

  private static func activeDeveloperDirectory() -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    process.arguments = ["-p"]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    do {
      try process.run()
    } catch {
      return nil
    }
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { return nil }
    let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}

/// US ANSI layout: printable ASCII to USB HID keyboard usages (page 0x07), with shift where
/// the character needs it. Verified on the Simulator: SimulatorKit's keyboard builder takes
/// HID usages (0x04 = a, 0x1E = 1, 0x2C = space, 0x28 = Return, 0x2A = Delete), not HIToolbox
/// virtual keycodes. Text is typed as discrete key events so the guest treats it as typing
/// rather than a paste.
enum KeyboardLayout {
  struct Stroke: Equatable {
    let usage: UInt16
    let modifiers: [SimulatorInputRequest.KeyModifier]
  }

  static let returnUsage: UInt16 = 0x28
  static let deleteUsage: UInt16 = 0x2A

  private static let plain: [Character: UInt16] = {
    var table: [Character: UInt16] = [:]
    for (offset, letter) in "abcdefghijklmnopqrstuvwxyz".enumerated() {
      table[letter] = UInt16(0x04 + offset)
    }
    for (offset, digit) in "1234567890".enumerated() {
      table[digit] = UInt16(0x1E + offset)
    }
    table["\n"] = returnUsage
    table["\t"] = 0x2B
    table[" "] = 0x2C
    table["-"] = 0x2D
    table["="] = 0x2E
    table["["] = 0x2F
    table["]"] = 0x30
    table["\\"] = 0x31
    table[";"] = 0x33
    table["'"] = 0x34
    table["`"] = 0x35
    table[","] = 0x36
    table["."] = 0x37
    table["/"] = 0x38
    return table
  }()

  private static let shifted: [Character: Character] = {
    var table: [Character: Character] = [:]
    for (upper, lower) in zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz") {
      table[upper] = lower
    }
    for (symbol, base) in zip("!@#$%^&*()", "1234567890") {
      table[symbol] = base
    }
    table["_"] = "-"
    table["+"] = "="
    table["{"] = "["
    table["}"] = "]"
    table["|"] = "\\"
    table[":"] = ";"
    table["\""] = "'"
    table["~"] = "`"
    table["<"] = ","
    table[">"] = "."
    table["?"] = "/"
    return table
  }()

  static func stroke(for scalar: Unicode.Scalar) -> Stroke? {
    let character = Character(scalar)
    if let usage = plain[character] {
      return Stroke(usage: usage, modifiers: [])
    }
    if let base = shifted[character], let usage = plain[base] {
      return Stroke(usage: usage, modifiers: [.shift])
    }
    return nil
  }
}
