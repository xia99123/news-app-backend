import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			// Test-only secret so the Slack signature checks run (the real one is a Worker secret).
			miniflare: { bindings: { SLACK_SIGNING_SECRET: "test-signing-secret" } },
		}),
	],
});
