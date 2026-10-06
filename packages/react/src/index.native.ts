import { setPlatform } from './platform-api';
import { nativePlatform } from './platform-native';

setPlatform(nativePlatform);

export * from './public';
