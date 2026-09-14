import { createRequire } from 'node:module';

/**
 * Read from package.json rather than duplicated as a literal.
 *
 * The version appears in --version, the report footer and the HTML metadata.
 * Three hand-maintained copies would drift, and a report stamped with the wrong
 * version is a small lie in a tool whose whole argument is that you can check
 * what it did.
 */
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const VERSION = pkg.version;
