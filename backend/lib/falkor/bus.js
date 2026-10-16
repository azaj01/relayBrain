const { EventEmitter } = require("events");

// Taps in existing modules emit here; the falkor module subscribes only when enabled.
const bus = new EventEmitter();
bus.setMaxListeners(50);

function emit(type, payload) {
  if (!bus.listenerCount(type)) return;
  try {
    bus.emit(type, payload);
  } catch (err) {
    console.warn(`[relay-falkor] ${type} listener failed: ${err.message || err}`);
  }
}

module.exports = { bus, emit };
