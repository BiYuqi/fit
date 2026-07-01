// Jest config for Expo SDK 56 + React Native 0.85
// Uses jest-expo preset which handles RN/Expo module mocking.
// @testing-library/react-native v12 works with react-test-renderer directly.

module.exports = {
  preset: 'jest-expo',

  moduleNameMapper: {
    // Static assets: stub CSS imports (e.g. @/global.css from theme.ts)
    '\\.css$': '<rootDir>/src/test/empty-module.js',
    // Path aliases (mirrors tsconfig.json)
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@/assets/(.*)$': '<rootDir>/assets/$1',
  },

  // Collect coverage from src, exclude test utilities and types
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/test/**',
  ],
};
