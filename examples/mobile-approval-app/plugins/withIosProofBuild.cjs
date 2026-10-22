/** Synthetic local Simulator proof only. No remote cleartext-load exception. */
const { withInfoPlist } = require('@expo/config-plugins');

module.exports = function withIosProofBuild(config) {
  return withInfoPlist(config, value => {
    value.modResults.CFBundleDisplayName = 'Testlane iOS Proof';
    // Individual IP exception domains are supported on iOS 17+. The proof uses
    // an iOS 26.4+ Simulator; bootstrap.mjs separately restricts the exact origin.
    value.modResults.NSAppTransportSecurity = {
      NSAllowsArbitraryLoads: false,
      NSExceptionDomains: {
        '127.0.0.1': { NSExceptionAllowsInsecureHTTPLoads: true, NSIncludesSubdomains: false },
      },
    };
    value.modResults.UIFileSharingEnabled = false;
    value.modResults.LSSupportsOpeningDocumentsInPlace = false;
    return value;
  });
};
