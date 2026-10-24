/** Test synchronization: an early background result must not become an unopened-gate timeout. */
export async function waitForProvisioningTestGate(entered: Promise<void>, pending: Promise<unknown>): Promise<void> {
  await Promise.race([entered, pending.then(outcome => { throw outcome ?? new Error("TEST_BACKGROUND_OPERATION_ENDED_BEFORE_GATE"); })]);
}
