const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Allow Metro to bundle .wasm files (used by expo-sqlite's web worker)
config.resolver.assetExts.push('wasm');

module.exports = config;
