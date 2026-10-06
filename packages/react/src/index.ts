import { setPlatform } from './platform-api';
import { webPlatform } from './platform-web';

setPlatform(webPlatform);

export * from './public';
