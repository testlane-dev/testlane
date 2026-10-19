/** Debuggable ONLY to deliver generated sandbox session files with adb run-as.
 * This synthetic proof APK must never be distributed as a production app. */
const { withAndroidManifest, withAppBuildGradle, withDangerousMod, withGradleProperties, withMainApplication } = require('@expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = function withProofBuild(config) {
  config = withAndroidManifest(config, value => {
    const application = value.modResults.manifest.application[0];
    application.$['android:debuggable'] = 'true';
    application.$['android:allowBackup'] = 'false';
    application.$['android:networkSecurityConfig'] = '@xml/testlane_network_security';
    return value;
  });
  config = withAppBuildGradle(config, value => {
    const matches = value.modResults.contents.match(/\brelease\s*\{/g) ?? [];
    if (value.modResults.language !== 'groovy' || matches.length !== 1) throw Error('PROOF_GRADLE_TEMPLATE_UNEXPECTED');
    value.modResults.contents = value.modResults.contents.replace(/\brelease\s*\{/, 'release {\n            // Synthetic sandbox proof only; JS remains release-bundled.\n            debuggable true');
    return value;
  });
  config = withMainApplication(config, value => {
    const expression = /ExpoReactHostFactory\.getDefaultReactHost\(\s*/g;
    if ((value.modResults.contents.match(expression) ?? []).length !== 1) throw Error('PROOF_APPLICATION_TEMPLATE_UNEXPECTED');
    value.modResults.contents = value.modResults.contents.replace(expression,
      'ExpoReactHostFactory.getDefaultReactHost(\n      useDevSupport = false,\n      jsBundleAssetPath = "index.android.bundle",\n      ');
    return value;
  });
  config = withGradleProperties(config, value => {
    for (const [key, setting] of [['android.enableMinifyInReleaseBuilds', 'false'], ['EX_DEV_CLIENT_NETWORK_INSPECTOR', 'false']]) {
      value.modResults = value.modResults.filter(entry => entry.type !== 'property' || entry.key !== key);
      value.modResults.push({ type: 'property', key, value: setting });
    }
    return value;
  });
  return withDangerousMod(config, ['android', async value => {
    const directory = path.join(value.modRequest.platformProjectRoot, 'app/src/main/res/xml');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'testlane_network_security.xml'),
      '<?xml version="1.0" encoding="utf-8"?>\n<network-security-config><base-config cleartextTrafficPermitted="false"/><domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">127.0.0.1</domain></domain-config></network-security-config>\n');
    return value;
  }]);
};
