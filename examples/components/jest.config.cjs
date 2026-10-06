module.exports = {
  preset: '@react-native/jest-preset',
  testMatch: ['<rootDir>/test/**/*.native.test.tsx'],
  transformIgnorePatterns: ['node_modules/(?!(\\.pnpm|react-native|@react-native|zod)/)'],
};
