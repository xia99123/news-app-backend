import { readFileSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Load secrets (AGENT_PASSWORD) from the git-ignored .env so they never live in test code.
try {
	for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split(/\r?\n/)) {
		const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
		if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
	}
} catch {
	// No .env (e.g. CI): expect AGENT_PASSWORD in the environment instead.
}

export default defineConfig({
	testDir: "./e2e",
	// These tests hit the live dashboard, Worker, and Claude: run one at a time and
	// never retry automatically, so a failure can't silently double the API cost.
	workers: 1,
	fullyParallel: false,
	retries: 0,
	timeout: 180_000,
	expect: { timeout: 15_000 },
	reporter: [["list"]],
	use: {
		baseURL: process.env.E2E_BASE_URL ?? "https://news-intelligence-dashboard.pages.dev",
		channel: "chrome", // use the installed Google Chrome; no browser download needed
		headless: true,
		viewport: { width: 1440, height: 900 },
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
	},
});
