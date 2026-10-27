// Basic dashboard behaviors, run against the live site.
//   npx playwright test e2e/dashboard.spec.js
// Uses AGENT_PASSWORD from .env (loaded by playwright.config.mjs).

import { test, expect } from "@playwright/test";

const PASSWORD = process.env.AGENT_PASSWORD;
const EXPECTED_TITLE = "AI News Intelligence Dashboard";

test.describe.configure({ mode: "serial" });

async function openDashboard(page) {
	await page.addInitScript((pw) => {
		if (sessionStorage.getItem("e2e-seeded")) return;
		sessionStorage.setItem("e2e-seeded", "1");
		localStorage.setItem("newsAgentPassword", pw);
		localStorage.setItem("chatWebSearch", "off");
		localStorage.removeItem("chatSystemPrompt");
	}, PASSWORD);
	await page.goto("/");
}

// 1 -------------------------------------------------------------------------
test("1. the page loads with the correct title", async ({ page }) => {
	await openDashboard(page);
	await expect(page).toHaveTitle(EXPECTED_TITLE);
	await expect(page.locator("h1")).toContainText(EXPECTED_TITLE);
	await expect(page.locator("article.card").first()).toBeVisible({ timeout: 30_000 });
});

// 2 -------------------------------------------------------------------------
test("2. typing a question and clicking Send produces a reply within 15 seconds", async ({ page }) => {
	await openDashboard(page);
	await expect(page.locator("article.card").first()).toBeVisible({ timeout: 30_000 });

	await page.fill("#chatInput", "In one sentence, what is the top Data Center story right now?");
	const started = Date.now();
	await page.getByRole("button", { name: "Send" }).click();

	const reply = page.locator(".msg.assistant").first();
	await expect(reply).toBeVisible({ timeout: 15_000 });
	const elapsed = Date.now() - started;
	console.log(`reply arrived in ${(elapsed / 1000).toFixed(1)}s`);
	expect(elapsed).toBeLessThan(15_000);
	expect((await reply.locator("p, li").allTextContents()).join(" ").trim().length).toBeGreaterThan(20);
	await expect(page.locator(".msg.error")).toHaveCount(0);
});

// 3 -------------------------------------------------------------------------
test("3. the model selector has at least 2 options", async ({ page }) => {
	await openDashboard(page);
	const selector = page.getByLabel("Model");
	await expect(selector).toBeVisible();
	const options = await selector.locator("option").allTextContents();
	console.log("model options:", options);
	expect(options.length).toBeGreaterThanOrEqual(2);
	expect(new Set(await selector.locator("option").evaluateAll((o) => o.map((x) => x.value))).size).toBe(options.length);
});

// 4 -------------------------------------------------------------------------
test("4. the system prompt area can be edited, and the edit is used", async ({ page }) => {
	await openDashboard(page);
	await expect(page.locator("article.card").first()).toBeVisible({ timeout: 30_000 });

	// It may live inside a collapsible section; open it if so.
	const promptBox = page.getByLabel("System prompt", { exact: true });
	if (!(await promptBox.isVisible().catch(() => false))) {
		const hood = page.locator("#hood summary");
		if (await hood.count()) await hood.click();
	}
	await expect(promptBox).toBeVisible();
	await expect(promptBox).toBeEditable();

	// It starts with the prompt actually in use, not an empty box.
	const original = await promptBox.inputValue();
	expect(original.length).toBeGreaterThan(50);

	// Editing changes the value...
	const custom = "You are a terse news assistant. Always begin every answer with the exact word PINEAPPLE, then answer in one sentence.";
	await promptBox.fill(custom);
	await expect(promptBox).toHaveValue(custom);

	// ...is sent with the next question...
	const exchange = page.waitForResponse((r) => r.url().endsWith("/chat") && r.request().method() === "POST", { timeout: 60_000 });
	await page.fill("#chatInput", "What is one Data Center story?");
	await page.getByRole("button", { name: "Send" }).click();
	const response = await exchange;
	const body = JSON.parse(response.request().postData());
	expect(body.system_prompt).toBe(custom);
	expect(response.status()).toBe(200);

	// ...and actually changes Claude's behavior.
	const reply = page.locator(".msg.assistant").first();
	await expect(reply).toBeVisible({ timeout: 60_000 });
	expect((await reply.locator("p").first().textContent()).trim()).toMatch(/^PINEAPPLE/i);

	// Resetting restores the default prompt.
	await page.getByRole("button", { name: /reset/i }).click();
	await expect(promptBox).toHaveValue(original);
});
