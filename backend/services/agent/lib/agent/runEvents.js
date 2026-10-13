import { EventEmitter } from "node:events";

// In-process pub/sub for live run updates, so the SSE endpoint can push the
// model's text to the browser in real time (instead of the UI polling). One
// emitter per active run; it's torn down when the run finishes.
const buses = new Map(); // runId -> EventEmitter

const busFor = (runId) => {
  const id = String(runId);
  let bus = buses.get(id);
  if (!bus) {
    bus = new EventEmitter();
    bus.setMaxListeners(0);
    buses.set(id, bus);
  }
  return bus;
};

// Emit a live event for a run: { type: "text", text } | { type: "done", status }.
export const emitRun = (runId, event) => {
  const bus = buses.get(String(runId));
  if (bus) bus.emit("event", event);
};

// Subscribe to a run's events; returns an unsubscribe function.
export const subscribeRun = (runId, handler) => {
  const bus = busFor(runId);
  bus.on("event", handler);
  return () => bus.off("event", handler);
};

// Drop a run's bus once it's finished and no one is listening soon after.
export const closeRunBus = (runId) => {
  const id = String(runId);
  const bus = buses.get(id);
  if (!bus) return;
  // Give any attached SSE clients a tick to receive the final "done" event.
  setTimeout(() => {
    bus.removeAllListeners();
    buses.delete(id);
  }, 1000).unref?.();
};
