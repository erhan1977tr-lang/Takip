import pkg from '../package.json';

/**
 * Uygulamanın sürümü (package.json). Her güncellemede artırılır:
 * yeni özellik → ikinci hane (3.1.0), düzeltme → üçüncü hane (3.0.1). Değişiklikler CHANGELOG.md'de.
 */
export const APP_VERSION: string = pkg.version;
