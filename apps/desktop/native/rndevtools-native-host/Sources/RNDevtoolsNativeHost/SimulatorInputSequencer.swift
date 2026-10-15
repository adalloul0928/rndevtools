import Foundation

/// Turns one input request into the ordered HID events every transport delivers, with the
/// pauses that make the guest read them as a human gesture (a tap holds, a swipe moves in
/// steps, a key stays down long enough to register). Transport-agnostic so the Indigo and
/// DTUHID paths produce identical gestures and the sequencing is testable without a device.
enum SimulatorInputSequencer {
  static let keyDownMilliseconds = 12
  static let keyGapMilliseconds = 8
  static let buttonHoldMilliseconds = 60
  static let swipeLiftMilliseconds = 30

  static func run(
    _ request: SimulatorInputRequest, pause: (Int) -> Void, deliver: (SimulatorInputEvent) throws -> Void
  ) throws {
    switch request {
    case let .tap(_, point, hold):
      try deliver(.touch(x: point.x, y: point.y, down: true))
      pause(hold)
      try deliver(.touch(x: point.x, y: point.y, down: false))
    case let .swipe(_, from, to, duration, steps):
      try deliver(.touch(x: from.x, y: from.y, down: true))
      let interval = max(1, duration / steps)
      for step in 1...steps {
        let fraction = Double(step) / Double(steps)
        pause(interval)
        try deliver(
          .touch(x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction, down: true))
      }
      pause(swipeLiftMilliseconds)
      try deliver(.touch(x: to.x, y: to.y, down: false))
    case let .text(_, text):
      for scalar in text.unicodeScalars {
        guard let stroke = KeyboardLayout.stroke(for: scalar) else { continue }
        try type(stroke, pause: pause, deliver: deliver)
      }
    case let .key(_, usage, modifiers):
      try type(KeyboardLayout.Stroke(usage: usage, modifiers: modifiers), pause: pause, deliver: deliver)
    case let .button(_, button):
      try deliver(.button(button, down: true))
      pause(buttonHoldMilliseconds)
      try deliver(.button(button, down: false))
    }
  }

  private static func type(
    _ stroke: KeyboardLayout.Stroke, pause: (Int) -> Void, deliver: (SimulatorInputEvent) throws -> Void
  ) throws {
    for modifier in stroke.modifiers {
      try deliver(.key(usage: modifier.usage, down: true))
    }
    try deliver(.key(usage: stroke.usage, down: true))
    pause(keyDownMilliseconds)
    try deliver(.key(usage: stroke.usage, down: false))
    for modifier in stroke.modifiers.reversed() {
      try deliver(.key(usage: modifier.usage, down: false))
    }
    pause(keyGapMilliseconds)
  }
}
