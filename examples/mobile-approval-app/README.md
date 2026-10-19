# Synthetic React Native approval proof

This is a new, disposable frontend for the public [approval demo backend](../verification-demo/README.md).
It renders native React Native controls for disposable sandbox accounts. The source
uses Expo 58.0.16, React Native 0.88.0, React 19.3.0 and Expo FileSystem 58.0.10,
pinned in its own lockfile. [Expo's SDK matrix](https://docs.expo.dev/versions/v58.0.0/)
records Node 22.13+ and compile SDK 37/target SDK 36 for this SDK.

The APK uses a fixed embedded release JavaScript bundle; Metro is not required at
runtime. Its reviewed config plugin deliberately makes this **synthetic proof build
debuggable**, so a controller can deliver a generated cookie through `adb run-as`.
Do not deploy this configuration, use real accounts or distribute the APK as a
production app. This example alone does not establish completed emulator acceptance
or general mobile-agent support.

## Build without touching a device

Requires a supported Node version, JDK 21 and existing accepted Android SDK licenses.
The pinned template/toolchain resolves compile SDK 37, target SDK 36, build-tools
37.0.0, NDK 27.1.12297006 and CMake 3.22.1. It uses Gradle 9.4.1 and Android Gradle
Plugin 9.2.1. Provision these exact SDK components separately before building.
The helper checks the fixed SDK, NDK, CMake, JDK and npm prerequisite files before
creating output or a temporary build root. APK inspection also uses build-tools
37.0.0; a newer installed tool does not replace that prerequisite.
For distributions that install npm separately from Node, run the repository's
`npm run build:android-proof --` command with the same flags; the helper validates
and uses npm's absolute `npm_execpath`. Direct invocation falls back to npm beside
the Node executable when that environment variable is absent.
From this directory on Windows:

```powershell
node build.mjs --output-dir 'C:/absolute/new-owned-output' --sdk-root 'C:/Users/you/AppData/Local/Android/Sdk' --java-home 'C:/Program Files/Android/Android Studio/jbr'
```

Use an actual **new** absolute output directory. `ANDROID_HOME`/`ANDROID_SDK_ROOT`
and `JAVA_HOME` can supply the tool locations instead of flags. The build copies only
the explicit public source allowlist into a short `tl-android-build-<nonce>/app/`
under the OS temp directory, runs `npm ci`, prebuilds from the pinned official bare
template, then calls Gradle's Java wrapper directly for x86_64 `assembleRelease`.
Node/npm/Java use argv arrays with `shell:false` and bounded execution. The command
does not launch an emulator, contact a phone, accept SDK licenses, install packages
on a device or start Metro. Gradle SDK auto-download is disabled so a separate scoped
SDK manager invocation owns tool installation; review any actual new license requirement.

On success the output contains `testlane-android-proof.apk`, private build logs and
`build-manifest.json`: source, plugin, lockfile and APK SHA-256, exact resolved package
versions, architecture and Android metadata. APK inspection verifies an embedded
bundle and the explicit proof-only debuggable package. Generated native projects,
node_modules and APKs stay out of Git. Success removes only the verified owned
temporary build root. Failure retains that root and a minimal recovery record for
inspection; there is no recursive cleanup of a caller-selected source directory.
Ctrl+C and termination requests cancel the active stage, stop its owned process
tree within a bounded wait and retain private recovery information. An unconfirmed
stop is reported explicitly and never treated as a successful cancellation.
`--prepare-only` stops after install/prebuild and retains the owned root for toolchain
inspection; it does not claim a completed APK.

## iOS Simulator Release build without Apple signing credentials

The iOS example reuses `App.js`, `bootstrap.mjs` and the pinned dependency lockfile.
It adds a separate `app.ios.config.cjs` and reviewed iOS config plugin. Android's
configuration stays separate. On iOS, the shared value controls expose their actual
text through `accessibilityValue`, while stable test IDs identify the controls.
Android keeps its original exact accessibility descriptions and native text.
An iOS-only input accessory provides an accessible Done control that dismisses
both numeric and ordinary keyboards. The proof uses that app-owned control and
checks dismissal before continuing with the form.

Build on macOS with supported Node, **Xcode 26.4+**, an iOS Simulator SDK 26.4+,
and an already installed CocoaPods executable. The selected Xcode must have its
license and first-launch setup completed. The helper checks these prerequisites;
it does not accept licenses, install Xcode or select a different developer directory.
The [Expo SDK matrix](https://docs.expo.dev/versions/v58.0.0/) documents the minimum
Xcode version. The proof is intended for the separately owned iOS 26.4+ Simulator.

From this example directory on macOS:

```sh
mkdir -p output
node build-ios.mjs --output-dir "$(pwd -P)/output/ios-build-001"
```

The output parent must already exist at its canonical path, and the final output
directory must be new. `buildIosProof({ outputDir, signal, onStage })` provides the
same operation as an importable API; `onStage` receives fixed stage names. A
non-macOS host refuses before creating output or a temporary build root. This
refusal and the local fixture tests are not evidence of a successful iOS build.

The helper copies seven explicit public inputs into a short owned OS temporary
directory. It maps the iOS config to `app.config.cjs`, verifies the pinned
`expo-template-bare-minimum@58.0.25` archive's SHA-512 integrity, runs `npm ci`,
prebuilds iOS without automatic installation, then runs CocoaPods and an
`iphonesimulator` **Release** build with `CODE_SIGNING_ALLOWED=NO`. It supplies no
Apple signing credentials, team or provisioning profile. The ARM64 linker may
still add a linker ad-hoc signature without an Apple Developer identity or team.
It never launches a Simulator, chooses an existing device, starts
Metro or installs the result. Each subprocess has a fixed timeout and output cap;
Ctrl+C, termination requests and an API abort signal stop the owned process group.
An unconfirmed stop retains a fixed failure code and recovery information.

The product is `TestlaneIOSProof.app`, bundle ID `dev.testlane.iosproof`. Its
embedded `main.jsbundle`, Simulator platform, actual architecture, executable
signature state and narrow ATS configuration are checked before success. The
manifest records `signature: "none"` or `signature: "linker-ad-hoc"`; `unsigned`
is true only for `"none"`. A linker ad-hoc signature has no Apple certificate
authority or team identifier and does not establish Developer-signed distribution.
The plugin sets
`NSAllowsArbitraryLoads` to false and permits cleartext HTTP only for the
`127.0.0.1` exception domain. It does not enable a blanket local-network exemption.
[Apple documents IP-address exception domains](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains)
for iOS 17 and later; bootstrap validation separately permits only an exact
`http://127.0.0.1:<owned-port>` origin.

Success returns an absolute `appDirectory`, `appSHA256`, `manifestFile` and resolved
package versions. `build-manifest.json` records every public input hash, their
source-to-destination mapping, the template, npm and CocoaPods dependency locks,
actual Xcode/SDK/package versions, and the copied app's canonical tree digest.
`hashIosTree(appDirectory)` is exported so the proof controller can verify that
exact bundle before and after execution. Its deterministic entries cover every
relative path, entry type, POSIX mode and file byte hash. Internal relative
symlinks retain their literal targets without being traversed; absolute, dangling
or escaping links are refused. Timestamps and extended attributes are outside
this digest. A successful copy must match the built tree before the owned build
root is removed. Failure retains that root, private logs and `recovery.json`.

On iOS, `Paths.document` maps the bootstrap to `Documents/testlane-bootstrap.json`
inside this app's data container. A separately controlled, newly created Simulator
can deliver that file through its private container. The unchanged app reads and
deletes it before accepting the generated session; it never displays or persists
the cookie. This synthetic build needs no Apple signing credentials and is for a
Simulator proof, not App Store
distribution, a physical phone, a real account or a general Expo-support claim.
Only the macOS build and actual native proof can establish that this path works.

## Session delivery and backend contract

The separately controlled emulator uses `adb reverse` for the app's exact backend
port. A controller writes a JSON bootstrap into this app's private
`files/testlane-bootstrap.json` **over stdin through `adb run-as`**. Never type a
cookie into the UI or put it in argv, an environment variable, a deep link, a test
log, a screenshot or committed configuration. The payload shape is:

```text
{schemaVersion: 1, origin: "http://127.0.0.1:<owned-port>", cookie: "tldemo_session=<issued-cookie-value>"}
```

Those angle-bracket values describe the contract, not a usable session. The app
accepts only a plain `http://127.0.0.1:<port>` origin and the single known cookie name
with a bounded safe token. Its Android network policy denies cleartext hosts other
than 127.0.0.1. On **Load sandbox session**, it reads the file, deletes it before
parsing or making a request, then keeps the cookie only in memory. A deletion failure
blocks acceptance. There is no credential entry, account creation, app login bypass
or persistent session store. Signing out drops the in-memory cookie/identity; it
does not revoke the backend's server session.

The public backend provides `/api/me`, `/api/requests`, resource reads/deletion and
resource approval, with `Editor`/`Reviewer` roles. The UI shows returned state; it
does not recompute the expected total. Thus a server defect returning 4199 cents
must show 4199, allowing an external oracle to detect the error. Both roles can
attempt approval, so the controller can observe Editor 403 and repeat-approval 409.
Anonymous checks omit the cookie and display the actual HTTP status. Errors use
fixed local codes; there is no raw response, cookie or error logging.

## Stable accessibility contract

Each ID is both an accessibility label and test ID. Text values remain available
as native text to an Android automation client:

| Action or value | ID |
| --- | --- |
| Load/delete bootstrap; sign out | `load-session`, `sign-out` |
| Identity and session state | `identity-email`, `identity-role`, `session-status` |
| Create inputs and action | `run-marker`, `quantity`, `unit-price`, `create-request` |
| Select/read/approve/refresh | `selected-id`, `load-request`, `approve-request`, `refresh-request` |
| Saved fields | `request-id`, `request-total`, `request-status`, `request-version`, `request-owner`, `request-approver`, `request-quantity`, `request-unit-price`, `request-marker` |
| Numeric last HTTP status; fixed outcome | `api-status`, `operation-status` |
| Anonymous refusal check | `anonymous-check` |

Quantity starts at 3 and unit price at 1400 cents. An external test should check
the 4200-cent oracle, every stable stored field after denial/conflict, and scoped
owned-record deletion with verified absence. This app does not supply that external
acceptance verdict or change what the backend considers authorized.

## Focused example tests

```sh
node --test tests/*.test.mjs
```

These check loopback/cookie validation, deletion ordering and missing-tool refusal
before build allocation. The iOS helper tests also cover canonical tree hashing,
symlink refusal, scoped removal, bounded subprocesses and cancellation using local
fixtures. They do not compile iOS on Windows or replace APK/app inspection and real
emulator/Simulator acceptance.
