module.exports = {
  expo: {
    name: 'TestlaneIOSProof', slug: 'testlane-ios-proof', version: '0.0.1',
    platforms: ['ios'], orientation: 'portrait', userInterfaceStyle: 'light',
    ios: { bundleIdentifier: 'dev.testlane.iosproof', buildNumber: '1', supportsTablet: false },
    plugins: ['./plugins/withIosProofBuild.cjs'],
  },
};
