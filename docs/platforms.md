# Platforms: setting up the secret store

A human runs `testlane store set <profile>` once per test account (hidden prompt or stdin, never
an argument). The secret goes into the operating system's keychain; agents later run `session` or
`check`, which read it from the same keychain and hand out only a session artifact.

| Platform | Store | You need |
| --- | --- | --- |
| Windows | `dpapi` | nothing to install |
| macOS | `keychain-macos` | an unlocked login keychain |
| Linux desktop | `secret-service` | `secret-tool` and a running, unlocked keyring |
| Linux headless, WSL, devcontainer | `secret-service` | the same, plus a D-Bus session you start yourself |

Testlane picks the store from the platform. `testlane store list` is a quick check (it prints
`no secrets stored` for an empty store) and the first `store set` proves the keychain accepts
writes. There is no plaintext fallback: with no keychain, commands fail with a message that names
what is missing and points here.

## The adapters

`store set` writes through the adapter that `src/store/select.ts` picks for the platform:

| Platform | Adapter | Notes |
| --- | --- | --- |
| Windows | `dpapi` | `<TESTLANE_HOME>/store/<base64url key>.dpapi`, CurrentUser DPAPI via a `powershell.exe` child (secret on stdin only) |
| macOS | `keychain-macos` | login keychain via `/usr/bin/security` (service `agent-auth`, a stable storage identifier kept from before the rename) |
| Linux | `secret-service` | freedesktop Secret Service via `secret-tool` (needs a session D-Bus and keyring); setup: see below |
| any | `encrypted-file` | AES-256-GCM files; the data key comes from the OS keychain, or from an interactive passphrase |

`TESTLANE_STORE` overrides the choice, see [the `encrypted-file` store and
`TESTLANE_STORE`](#the-encrypted-file-store-and-testlane_store).

## Windows

Secrets are encrypted with DPAPI for the Windows user who ran `store set` and kept as files under
`<TESTLANE_HOME>/store` (default `%USERPROFILE%\.testlane\store`). Nothing to install. They are
per user: a scheduled task must run as that same user. Any process running as that user can
decrypt them, so keeping agents out of the store is a permission rule (see
[threat-model.md](threat-model.md)).

## macOS

Secrets live in the login keychain, written and read through `/usr/bin/security` (service
`agent-auth`, one item per profile). The keychain must be unlocked: it normally is while you are
logged in at the machine, but it can be locked in an ssh session or after its lock timeout. A
scheduled task needs the user's unlocked login keychain, so run it as the user who ran
`store set`, while that user is logged in.

## Linux desktop

The store is the freedesktop Secret Service (GNOME Keyring, or KWallet or KeePassXC serving the
same API), reached with libsecret's `secret-tool`. On a desktop session the keyring is unlocked
at login. Install the tool if `secret-tool` is missing:

```sh
sudo apt install libsecret-tools gnome-keyring   # Debian / Ubuntu
sudo dnf install libsecret gnome-keyring         # Fedora
```

Start `testlane` and the agent from that desktop session. A new ssh login, `su` or `sudo` has no
session bus; use the headless steps below there.

## Linux headless, WSL, devcontainer

There is no desktop session, so no D-Bus session bus and no running keyring. Start a private bus,
unlock a keyring inside it, and run everything from that shell.

1. Install the packages (`dbus-daemon` provides `dbus-run-session` and is usually present):

   ```sh
   sudo apt install libsecret-tools gnome-keyring dbus-daemon   # Debian / Ubuntu
   sudo dnf install libsecret gnome-keyring dbus-daemon         # Fedora
   ```

2. Start a shell with its own session bus:

   ```sh
   dbus-run-session -- bash
   ```

3. In that shell, unlock gnome-keyring with a password read from a prompt and piped on stdin,
   never on the command line:

   ```sh
   read -rs pw; printf '%s' "$pw" | gnome-keyring-daemon --unlock --components=secrets; unset pw
   ```

   The first run creates the keyring with this password. Choose one you will remember and type
   the same one every time: a different password leaves the keyring locked.

4. Store the secret and check it, still in that shell:

   ```sh
   testlane store set <profile>    # type the secret at the hidden prompt, or pipe it on stdin
   testlane store list             # prints <profile>
   ```

5. Start the agent from this same shell, so it inherits the bus (`DBUS_SESSION_BUS_ADDRESS`).
   A different terminal, a service or a scheduled job does not share it and cannot reach the
   keyring.

When the shell exits, the bus and the keyring daemon stop. The keyring file stays in
`~/.local/share/keyrings`; next time repeat steps 2 and 3. In a devcontainer, install the
packages in the image and open `dbus-run-session -- bash` in the terminal you start the agent
from. For a throwaway keyring (tests, CI), also set a private `XDG_DATA_HOME` before step 2.

### What the messages mean

| Message says | Cause | Fix |
| --- | --- | --- |
| `secret-tool is not on PATH` | libsecret's tool is not installed | step 1 |
| `D-Bus session bus` | `DBUS_SESSION_BUS_ADDRESS` unset or stale (`Cannot autolaunch D-Bus without X11 $DISPLAY`) | step 2, and run the agent from that shell |
| `no Secret Service keyring is running` | a bus, but no keyring on it (`org.freedesktop.secrets was not provided by any .service files`) | install `gnome-keyring`, step 3 |
| `keyring is locked (or has no default collection)` | the keyring is not unlocked in this session, or it was unlocked with another password | step 3, with the password that created it |

If you no longer know that password and have stored nothing in that keyring yet (for example a
typo created it), delete `login.keyring` and `user.keystore` (if present) in
`~/.local/share/keyrings`, which erases everything in that keyring, and repeat step 3.

`secret-tool` answers a lookup on a locked keyring the same way as a lookup of a missing item, so
`session` can report "No secret stored" for a profile you did store. `store set` reports the lock
explicitly, and so does `store list` when anything is stored.

## The `encrypted-file` store and `TESTLANE_STORE`

`TESTLANE_STORE=dpapi|keychain-macos|secret-service|encrypted-file` overrides the choice (the
pre-rename `AGENT_AUTH_STORE` still works). It only changes how secrets are protected at rest;
production refusal, host allowlists, TTL caps and origin binding are enforced above the store and
apply unchanged.

`encrypted-file` keeps AES-256-GCM files under `<TESTLANE_HOME>/store`. Its 32-byte key is held
in the OS keychain when there is one (item `agent-auth/encrypted-file.key.v1`, hidden from
`store list`), which works unattended. Without a keychain it asks for a passphrase, and only
when you opted in with `TESTLANE_STORE=encrypted-file`:

- The passphrase is asked for twice on first use (a mismatch writes nothing), once per run after.
  The salt file (`encrypted-file.salt.json`) also holds a check value, so a mistyped passphrase
  is refused as "wrong passphrase" before any entry is read or written.
- It is typed at an interactive terminal: piped stdin is refused and it is never read from an
  environment variable, an argument or a file. Run `testlane store set` at that terminal and
  type the secret at its prompt too.
- An unattended agent cannot type it, so it cannot use this mode. Agents need a keychain-backed
  key.

Profile names starting with `encrypted-file.` are reserved: the registry schema rejects them,
because they would share store keys with the encrypted-file data key.

## Isolation: `TESTLANE_HOME` does not isolate secrets on macOS and Linux

On Windows (and for the `encrypted-file` files) secrets live under `<TESTLANE_HOME>/store`, so a
different `TESTLANE_HOME` is a different store. On macOS and Linux the entries are in the user's
real keychain, service `agent-auth`, key `agent-auth/<profile>`, whatever `TESTLANE_HOME` is.
`TESTLANE_HOME` there only moves the registry, audit log and (macOS) the `store list` index.

So a test that sets `TESTLANE_HOME` still reads and writes the real keychain: use throwaway
profile names, and remove what you stored with `testlane store delete <profile>` (it works from
any `TESTLANE_HOME`). For a disposable Linux keyring use a private `XDG_DATA_HOME` inside
`dbus-run-session`, as above.
