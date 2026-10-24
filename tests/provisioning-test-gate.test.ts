import { expect, it } from "vitest";
import { waitForProvisioningTestGate } from "./provisioning-test-gate.js";
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

it("propagates an actual early background refusal instead of waiting forever for an unopened gate", async () => {
  const entered = gate(), failure = new Error("BROWSER_PRIVATE_DIRECTORY_REFUSED");
  const pending = Promise.resolve(failure);
  await expect(waitForProvisioningTestGate(entered.promise, pending)).rejects.toBe(failure);
});

it("accepts real gate entry while retaining background work until released and joined before disposal", async () => {
  const entered = gate(), hold = gate(), events: string[] = [];
  const pending = (async () => { entered.release(); await hold.promise; events.push("settled"); return null; })();
  try { await waitForProvisioningTestGate(entered.promise, pending); expect(events).toEqual([]); }
  finally { events.push("released"); hold.release(); await pending; events.push("disposed"); }
  expect(events).toEqual(["released", "settled", "disposed"]);
});

it("also observes a rejected background promise and refuses unexpected successful completion before entry", async () => {
  const failure = new Error("BROWSER_ACCOUNT_STATE_INVALID"), entered = gate();
  await expect(waitForProvisioningTestGate(entered.promise, Promise.reject(failure))).rejects.toBe(failure);
  await expect(waitForProvisioningTestGate(entered.promise, Promise.resolve(null))).rejects.toThrow("TEST_BACKGROUND_OPERATION_ENDED_BEFORE_GATE");
});
