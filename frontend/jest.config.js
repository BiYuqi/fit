// Jest config for Expo SDK 56 + React Native 0.85
// Uses jest-expo preset which handles RN/Expo module mocking.
// @testing-library/react-native v12 works with react-test-renderer directly.

module.exports = {
  preset: 'jest-expo',

  // Reanimated 4 走 react-native-worklets，`*.native.ts` 入口在 jest 里会因为拿不到
  // 原生模块直接抛 "Native part of Worklets doesn't seem to be initialized"。
  // 官方 resolver 的作用就是在解析 worklets 时剔掉 .native 扩展名。
  resolver: 'react-native-worklets/jest/resolver',

  // 手势组件（ReanimatedSwipeable 等）需要 gesture-handler 自带的 mock
  setupFiles: ['<rootDir>/node_modules/react-native-gesture-handler/jestSetup.js'],

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
