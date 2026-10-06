// Expo detects the monorepo (watch folders, node_modules paths) automatically.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
