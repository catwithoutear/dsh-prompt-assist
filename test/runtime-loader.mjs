// Tests may reuse the active profile's installed Harness packages without installing a second DSH.
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const FALLBACKS = ['zod', '@deepseek-ai/cordis', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/schemastery'];
if (process.env.DSH_PROFILE_DIR) {
  const require = createRequire(`${process.env.DSH_PROFILE_DIR}/package.json`);
  registerHooks({ resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !FALLBACKS.includes(specifier)) throw error;
      return nextResolve(pathToFileURL(require.resolve(specifier)).href, context);
    }
  } });
}
