import { createBaseConfig, reactConfig, testConfig, prettierConfig } from '@hushbox/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ['src/routeTree.gen.ts'],
  },
  ...createBaseConfig(import.meta.dirname),
  {
    files: ['ios/**/*.test.ts', 'android/**/*.test.ts'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'ios/App/App.xcodeproj/project.pbxproj.test.ts',
            'ios/App/App/PrivacyInfo.test.ts',
            'ios/App/App/App.entitlements.test.ts',
            'ios/fastlane/Fastfile.test.ts',
            'android/app/src/main/AndroidManifest.test.ts',
            'android/fastlane/Fastfile.test.ts',
          ],
        },
      },
    },
  },
  ...reactConfig,
  ...testConfig,
  prettierConfig,
];
