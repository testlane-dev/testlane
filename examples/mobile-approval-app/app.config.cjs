module.exports = {
  expo: {
    name: 'Testlane Android Proof', slug: 'testlane-android-proof', version: '0.0.1',
    platforms: ['android'], orientation: 'portrait', userInterfaceStyle: 'light',
    android: { package: 'dev.testlane.androidproof', versionCode: 1, allowBackup: false },
    plugins: ['./plugins/withProofBuild.cjs'],
  },
};
