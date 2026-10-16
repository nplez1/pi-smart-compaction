/**
 * Test-only ESM resolver hook.
 *
 * 1. Maps the TypeScript ESM convention (`./decision.js` meaning `./decision.ts`),
 *    which Pi's jiti loader resolves but bare `node --test` does not.
 * 2. Aliases `@earendil-works/pi-tui` to a stub, because the extension imports a
 *    runtime component from a host package that is not installed in the repo.
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const PI_TUI_STUB = new URL("./stubs/pi-tui.ts", import.meta.url).href;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-tui") {
			return nextResolve(PI_TUI_STUB, context);
		}
		if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
			const asTypeScript = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
			if (existsSync(fileURLToPath(asTypeScript))) return nextResolve(asTypeScript.href, context);
		}
		return nextResolve(specifier, context);
	},
});
