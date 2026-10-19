/**
 * The demo's "try this in a second terminal" block.
 *
 * Headless Linux runs the demo on a private D-Bus session, so the keyring is
 * reachable only on that session's bus: the block must hand the second
 * terminal DBUS_SESSION_BUS_ADDRESS (a socket path, not a secret), or the
 * agent-side commands fail with "no keychain available". It must also not
 * claim the vault is isolated where it is not (macOS and Linux keychains).
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "..");
const { tryThisBlock } = (await import(
  pathToFileURL(path.join(repo, "examples", "demo-app", "scripts", "lib.mjs")).href
)) as { tryThisBlock: (port: number, broker: { prefix: string[] }) => string };

const broker = { prefix: ["/repo/dist/cli.js"] };
const saved = process.env["DBUS_SESSION_BUS_ADDRESS"];

afterEach(() => {
  if (saved === undefined) delete process.env["DBUS_SESSION_BUS_ADDRESS"];
  else process.env["DBUS_SESSION_BUS_ADDRESS"] = saved;
});

describe("tryThisBlock", () => {
  it("prints an export of DBUS_SESSION_BUS_ADDRESS, before the TESTLANE_HOME line, when it is set", () => {
    process.env["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/tmp/dbus-AbC123,guid=0123456789abcdef";
    const block = tryThisBlock(3000, broker);
    const exportLine = "export DBUS_SESSION_BUS_ADDRESS='unix:path=/tmp/dbus-AbC123,guid=0123456789abcdef'";
    expect(block).toContain(exportLine);
    expect(block.indexOf(exportLine)).toBeLessThan(block.indexOf("export TESTLANE_HOME="));
  });

  it("words the DBUS line neutrally: the variable is also set on an ordinary desktop", () => {
    process.env["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/run/user/1000/bus";
    const block = tryThisBlock(3000, broker);
    expect(block).toContain("# to use the same keyring session from another terminal, run");
    expect(block).not.toMatch(/private D-Bus session/i);
  });

  it("shell-quotes the address", () => {
    process.env["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/tmp/it's here";
    expect(tryThisBlock(3000, broker)).toContain(`export DBUS_SESSION_BUS_ADDRESS='unix:path=/tmp/it'\\''s here'`);
  });

  it.each([undefined, ""])("prints no DBUS line when the variable is %j", (value) => {
    if (value === undefined) delete process.env["DBUS_SESSION_BUS_ADDRESS"];
    else process.env["DBUS_SESSION_BUS_ADDRESS"] = value;
    expect(tryThisBlock(3000, broker)).not.toContain("DBUS_SESSION_BUS_ADDRESS");
  });

  it("does not call the vault isolated, and says how to delete the stored secrets off Windows", () => {
    const block = tryThisBlock(3000, broker);
    expect(block).not.toMatch(/throwaway vault/i);
    if (process.platform !== "win32") {
      expect(block).toContain("TESTLANE_HOME does not isolate them from your real vault");
      expect(block).toContain("npm --prefix examples/demo-app run clean");
    }
  });
});
