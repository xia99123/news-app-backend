import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			// Test-only secrets so the auth checks run (the real ones are Worker secrets).
			miniflare: { bindings: { SLACK_SIGNING_SECRET: "test-signing-secret", AGENT_PASSWORD: "test-agent-password" } },
		}),
	],
	// Worker unit tests only; e2e/ is run by Playwright against the live site.
	test: { include: ["test/**/*.spec.js"] },
});
