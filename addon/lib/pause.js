'use strict';
// The pause gate every long job cooperates with. Exposes globalThis.SarvaPause.
//
// A rebuild, a catch-up and a verify/repair are all long loops that touch the
// index a step at a time: one header from the walk, one body read, one batch
// write. Pause is cooperative, not a cancellation — each loop calls
// checkpoint() at its safe points and blocks there while the gate is shut, so
// nothing is half-written, no message is skipped, and resuming continues at
// the same place.
//
// The gate lives in the background page's memory on purpose: the loops that
// wait on it are all background scripts, so no cross-context state is needed
// (and none could be trusted anyway — the UI is closed at random). UI pages
// only ever send pause/resume and read the resulting state back out of the
// job status.
(function () {
  let paused = false;
  let waiters = [];

  function isPaused() {
    return paused;
  }

  // Await this at every safe point in a long loop. Unpaused is a synchronous
  // no-op (undefined), so the 100k-message walks that are never paused pay
  // one microtask per step, not a promise + allocation.
  function checkpoint() {
    if (!paused) return undefined;
    return new Promise((resolve) => waiters.push(resolve));
  }

  // Returns whether this call actually changed the state, so a UI double-click
  // can tell "paused" from "already paused".
  function pause() {
    if (paused) return false;
    paused = true;
    return true;
  }

  function resume() {
    if (!paused) return false;
    paused = false;
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
    return true;
  }

  globalThis.SarvaPause = { isPaused, checkpoint, pause, resume };
})();
