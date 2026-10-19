# Native mobile testing proposal

Native Android and iOS testing is planned work. Testlane 0.7.0-beta.2 verifies web
applications with Playwright; it has no native app runner, device manager or native
session bootstrap. Changing a browser viewport does not verify a native app.

The intended workflow stays the same: describe a feature to an existing coding agent,
review app-owned tests, run them against a dedicated test environment, and inspect
case outcomes, backend state and cleanup. A native runner adapter should supply device
interaction while Testlane keeps the execution and evidence contract explicit.

## First working proof

Start with one public, synthetic **React Native/Expo** approval app on an Android
emulator. Keep its backend and example data independent of any internal application.
Then repeat the workflow in an iOS simulator on macOS. Native Swift or Kotlin and
Flutter can follow after separate compatibility trials.

Use an app-owned test build with a known application ID and fixed native and JavaScript
inputs. Expo supports local development builds using Android Studio or Xcode; an
Expo account is not required for that local build path. See the
[Expo development build guide](https://docs.expo.dev/develop/development-builds/introduction/).
An Expo Go session alone does not establish compatibility with the application's own
native build. If a development server supplies JavaScript, bind the run to its bundle
revision and detect changes during execution.

| First target | Required environment | Acceptance status |
| --- | --- | --- |
| React Native/Expo on Android | A pinned test build, Android SDK, emulator and platform driver | Planned; no native device proof published |
| React Native/Expo on iOS | A pinned simulator build, macOS, Xcode, iOS Simulator and platform driver | Planned; must be validated independently of Android |

The first proof must cover:

1. Dedicated editor and reviewer identities, confirmed inside the app and backend.
2. Creating a request in the native UI and asserting its exact persisted total.
3. Denied approval by the editor, with every stable saved field unchanged.
4. One successful reviewer approval and an unchanged record after a duplicate denial.
5. Anonymous API denial, removal of test-owned records and verified absence.
6. The unchanged suite passing, failing on an injected total defect, and passing after
   correction. Check cleanup independently after all three runs.

An emulator-only proof will be labeled as such. Physical devices, notifications,
biometrics, camera permissions, offline synchronization, store purchases and mixed
native/WebView flows each require additional tests and evidence.

## Runner evaluation

Use an established open-source runner for device automation. The first integration
spike should evaluate Appium with a JavaScript client: its driver model separates
platform control from test code, which fits app-owned business assertions. Appium
requires a platform driver and a language client in addition to its core server.
See [Appium architecture](https://appium.io/docs/en/latest/intro/) and
[driver and client choices](https://appium.io/docs/en/latest/ecosystem/).

Maestro is a second candidate for teams that want YAML flows. Its flow format and
JavaScript assertions need an equally strict mapping from planned cases to observed
assertions and teardown outcomes. See [Maestro documentation](https://docs.maestro.dev/)
and [assertTrue](https://docs.maestro.dev/reference/commands-available/asserttrue.md).
The integration decision depends on a real device-run comparison, not API mocks.

Keep adapters separate from the current Playwright runner. A command exiting zero,
a visible screen or an arbitrary success annotation must not establish that all
planned assertions and cleanup ran. Version the native plan and journal contracts
explicitly rather than passing native results off as Playwright evidence.

## Authentication and evidence requirements

Browser cookie files are not a general native authentication mechanism. A native
integration needs an app-specific, reviewed sign-in or session-bootstrap contract
bound to the intended test build, backend, account and device. It must reject production
targets and unsupported bootstrap modes before mutating app state.

The synthetic proof can generate disposable credentials in its private controller.
Real-app support must establish how short-lived sessions reach the app without exposing
stored passwords to ordinary agent interactions. Credentials must not be placed in
shell arguments, launch arguments, environment variables, screenshots or retained
driver logs. Device transport and test code still need live session access; the
adapter is not a sandbox for code running as the same OS user.

Retain fixed failure categories, case IDs, source and build hashes, device configuration
and cleanup outcomes by default. Screen recordings, UI hierarchies and device logs
can contain private application data and require a separate retention policy. Leave
them off until that policy and its leak tests exist.

Cancellation must stop only sessions and app processes owned by the run. Cleanup
should identify and delete only that run's records; an app reinstall or a broad device
reset is not proof that backend data was removed. Forced-stop outcomes must report
unknown cleanup and leave a minimal private recovery journal where needed.

## Release gate

Before calling native mobile supported, publish the exact app source and build recipe,
pin the runner and driver versions, and record Android and iOS results separately.
Exercise the installed Testlane package, the real runner, an actual emulator or
simulator and the intended credential path. Test cancellation, a failed assertion,
setup failure, duplicate or skipped cases, recovery and secret-leak checks as well as
the successful workflow.

Until that gate passes, native support remains a proposal. Current supported behavior
and scoped acceptance results stay in [compatibility.md](compatibility.md).
