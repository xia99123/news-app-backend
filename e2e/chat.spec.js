// End-to-end tests for the dashboard chat panel, run against the live site
// (Pages dashboard -> Worker /chat -> D1 + Claude).
//
//   npm run test:e2e        routine run: scenarios 1, 2, 3, 5 (~6 Claude calls)
//   npm run test:e2e:full   also runs scenario 4 (@websearch), which does a paid web search
//
// AGENT_PASSWORD is read from .env by playwright.config.mjs. Assertions check structure
// (citations, token counts, request bodies), never Claude's exact wording.

import { test, expect } from "@playwright/test";

const PASSWORD = process.env.AGENT_PASSWORD;
const ANSWER_TIMEOUT = 90_000;

test.describe.configure({ mode: "serial" });
test.beforeAll(() => {
	if (!PASSWORD) throw new Error("AGENT_PASSWORD is not set (add it to .env)");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open the dashboard with web search off and (by default) the password already saved. */
async function openDashboard(page, { savePassword = true } = {}) {
	await page.addInitScript(
		({ pw, save }) => {
			// Only seed state on the first load of this test, so reloads keep what the UI changed.
			if (sessionStorage.getItem("e2e-seeded")) return;
			sessionStorage.setItem("e2e-seeded", "1");
			localStorage.setItem("chatWebSearch", "off");
			if (save) localStorage.setItem("newsAgentPassword", pw);
			else localStorage.removeItem("newsAgentPassword");
		},
		{ pw: PASSWORD, save: savePassword },
	);
	await page.goto("/");
	await expect(page.locator("article.card").first()).toBeVisible({ timeout: 30_000 });
}

/** Waits for the next POST /chat and returns { request body, status, response JSON }. */
function nextChatExchange(page) {
	return page
		.waitForResponse((r) => r.url().endsWith("/chat") && r.request().method() === "POST", { timeout: ANSWER_TIMEOUT })
		.then(async (r) => ({
			body: JSON.parse(r.request().postData() || "{}"),
			headers: r.request().headers(),
			status: r.status(),
			data: await r.json().catch(() => ({})),
		}));
}

/** Types a question, sends it with Enter, and waits for the answer bubble. */
async function ask(page, question) {
	const before = await page.locator(".msg.assistant").count();
	const exchange = nextChatExchange(page);
	await page.fill("#chatInput", question);
	await page.press("#chatInput", "Enter");
	const result = await exchange;
	expect(result.status, `chat failed: ${JSON.stringify(result.data)}`).toBe(200);
	await expect(page.locator(".msg.assistant")).toHaveCount(before + 1, { timeout: ANSWER_TIMEOUT });
	return result;
}

const lastAnswer = (page) => page.locator(".msg.assistant").last();
const toInt = (text) => Number(String(text).replace(/[^\d]/g, ""));

/** Reads a value from the "Under the hood" stats list by its label. */
async function hoodValue(page, label) {
	return page.locator("#hoodStats dt", { hasText: label }).locator("xpath=following-sibling::dd[1]").textContent();
}

// ---------------------------------------------------------------------------
// 1. Grounded answer with working citations
// ---------------------------------------------------------------------------
test("1. answers from the database with working citations and token usage", async ({ page }) => {
	await openDashboard(page);
	await page.selectOption("#chatModel", "haiku");

	const exchange = nextChatExchange(page);
	await page.click('.suggestions button[data-q="What are the most important stories this week?"]');
	const { body, data } = await exchange;
	await expect(page.locator(".msg.assistant")).toHaveCount(1, { timeout: ANSWER_TIMEOUT });

	// Request: the suggested question, Fast model, no web search.
	expect(body.question).toBe("What are the most important stories this week?");
	expect(body.model).toBe("haiku");
	expect(body.web_search).toBe(false);

	// The "thinking" placeholder is gone and the answer has real content.
	await expect(page.locator(".msg.thinking")).toHaveCount(0);
	const answer = lastAnswer(page);
	expect((await answer.locator("p, li").allTextContents()).join(" ").length).toBeGreaterThan(50);

	// At least one [id] citation, and every one links to an article the API used as context.
	const contextUrls = new Set(data.sources.map((s) => new URL(s.url).href));
	const cites = answer.locator("a.cite");
	expect(await cites.count()).toBeGreaterThan(0);
	for (const href of await cites.evaluateAll((els) => els.map((a) => a.href))) {
		expect(href).toMatch(/^https?:\/\//);
		expect(contextUrls.has(href), `citation ${href} is not one of the context articles`).toBe(true);
	}

	// Token chips on the answer match the API's usage and article context.
	const chips = answer.locator(".chip");
	expect(toInt(await chips.filter({ hasText: / in$/ }).textContent())).toBe(data.usage.input_tokens);
	expect(toInt(await chips.filter({ hasText: / out$/ }).textContent())).toBe(data.usage.output_tokens);
	expect(data.usage.input_tokens).toBeGreaterThan(0);
	expect(data.usage.output_tokens).toBeGreaterThan(0);
	const articleChip = await chips.filter({ hasText: "articles" }).textContent();
	const [, articleCount, articleTokens] = articleChip.match(/(\d+) articles · ≈([\d,]+) tok/);
	expect(Number(articleCount)).toBe(data.context.articles_considered);
	expect(Number(articleCount)).toBeGreaterThan(0);
	expect(toInt(articleTokens)).toBeGreaterThan(0);
	await expect(answer.locator(".chip.web")).toHaveCount(0);

	// Conversation total reflects exactly this one answer.
	const usage = await page.textContent("#chatUsage");
	expect(usage).toContain("1 answer");
	const [inTotal, outTotal] = usage.match(/[\d,]+(?= (in|out))/g).map(toInt);
	expect(inTotal).toBe(data.usage.input_tokens);
	expect(outTotal).toBe(data.usage.output_tokens);
});

// ---------------------------------------------------------------------------
// 2. Model selector controls which model answers
// ---------------------------------------------------------------------------
test("2. the model selector switches between Fast (Haiku) and Capable (Sonnet)", async ({ page }) => {
	await openDashboard(page);
	const question = "In one sentence, what is the top Data Center story?";

	for (const [option, modelId, label] of [
		["haiku", "claude-haiku-5-5", "Haiku 5.5"],
		["sonnet", "claude-sonnet-5-5", "Sonnet 5.5"],
	]) {
		await page.selectOption("#chatModel", option);
		const { body, data } = await ask(page, question);
		expect(body.model).toBe(option);
		expect(data.model).toBe(modelId);
		await expect(lastAnswer(page).locator(".msg-meta")).toContainText(label);
		expect(await hoodValue(page, "Model")).toBe(label);
	}
});

// ---------------------------------------------------------------------------
// 3. Follow-ups keep context; New chat resets it
// ---------------------------------------------------------------------------
test("3. follow-up questions carry history, and New chat clears it", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 760 }); // smaller panel so two answers overflow
	await openDashboard(page);
	await page.selectOption("#chatModel", "haiku");

	const first = await ask(page, "What's happening with AI data center power and energy?");
	expect(first.body.history).toEqual([]);

	const second = await ask(page, "Which of those involves the largest dollar amount?");
	expect(second.body.history).toHaveLength(2);
	expect(second.body.history[0]).toEqual({ role: "user", content: "What's happening with AI data center power and energy?" });
	expect(second.body.history[1].role).toBe("assistant");
	expect(second.body.history[1].content).toBe(first.data.answer);
	expect(await lastAnswer(page).locator("a.cite").count()).toBeGreaterThan(0);

	// Running total = sum of both answers.
	const usage = await page.textContent("#chatUsage");
	expect(usage).toContain("2 answers");
	const [inTotal, outTotal] = usage.match(/[\d,]+(?= (in|out))/g).map(toInt);
	expect(inTotal).toBe(first.data.usage.input_tokens + second.data.usage.input_tokens);
	expect(outTotal).toBe(first.data.usage.output_tokens + second.data.usage.output_tokens);

	// The conversation area scrolls.
	const scroll = await page.locator("#chatLog").evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, oy: getComputedStyle(el).overflowY }));
	expect(scroll.oy).toBe("auto");
	expect(scroll.sh).toBeGreaterThan(scroll.ch);

	// New chat clears the conversation; the next request has no history.
	await page.click("#chatClear");
	await expect(page.locator(".msg")).toHaveCount(0);
	await expect(page.locator("#chatEmpty")).toBeVisible();
	await expect(page.locator("#chatUsage")).toHaveText("Token usage appears after each answer.");

	// Verify the next request's history without spending a Claude call.
	let interceptedBody;
	await page.route("**/chat", (route) => {
		interceptedBody = JSON.parse(route.request().postData());
		route.fulfill({
			status: 200,
			headers: { "Access-Control-Allow-Origin": "*" },
			json: { answer: "ok", model: "claude-haiku-5-5", sources: [], context: { articles_considered: 0, article_context_tokens: 0 }, web_search: { enabled: false, searches: 0, queries: [], sources: [] }, usage: { input_tokens: 1, output_tokens: 1 } },
		});
	});
	await page.fill("#chatInput", "Fresh question");
	await page.press("#chatInput", "Enter");
	await expect(page.locator(".msg.assistant")).toHaveCount(1);
	expect(interceptedBody.history).toEqual([]);
});

// ---------------------------------------------------------------------------
// 4. Web search toggle is wired to the API  (optional: npm run test:e2e:full)
// ---------------------------------------------------------------------------
test("4. the web search toggle controls real web searches @websearch", async ({ page }) => {
	test.setTimeout(300_000);
	await openDashboard(page);
	await page.selectOption("#chatModel", "sonnet");
	const question = "What is Nvidia's latest stock price?";

	await page.click("#hood summary");
	await expect(page.locator("#webSearchToggle")).not.toBeChecked();
	await expect(page.locator("#hoodBadge")).toHaveText("Web search off");

	// OFF: no web search requested or performed.
	const off = await ask(page, question);
	expect(off.body.web_search).toBe(false);
	expect(off.data.web_search.enabled).toBe(false);
	expect(off.data.web_search.searches).toBe(0);
	expect(await hoodValue(page, "Web search")).toBe("off");
	await expect(page.locator("#hoodStats .legend")).toContainText("from articles");
	await expect(lastAnswer(page).locator(".chip.web")).toHaveCount(0);

	// ON: request says so, Claude searches, and the panel shows the extra context.
	await page.click(".switch-row");
	await expect(page.locator("#webSearchToggle")).toBeChecked();
	await expect(page.locator("#hoodBadge")).toHaveText("🌐 Web search on");
	await page.click("#chatClear");

	const on = await ask(page, question);
	expect(on.body.web_search).toBe(true);
	expect(on.data.web_search.enabled).toBe(true);
	expect(on.data.web_search.searches).toBeGreaterThanOrEqual(1);
	expect(await hoodValue(page, "Web search")).toMatch(/^on · [1-9]\d* search(es)?$/);
	expect(await page.locator("#hoodStats .queries li").count()).toBeGreaterThanOrEqual(1);
	expect(on.data.usage.input_tokens).toBeGreaterThan(3 * on.data.context.article_context_tokens);
	await expect(lastAnswer(page).locator(".chip.web")).toContainText("web search");
	expect(await lastAnswer(page).locator(".web-sources a").count()).toBeGreaterThanOrEqual(1);

	// The setting survives a reload; then turn it back off.
	await page.reload();
	await expect(page.locator("#webSearchToggle")).toBeChecked();
	await page.click("#hood summary");
	await page.click(".switch-row");
	await expect(page.locator("#webSearchToggle")).not.toBeChecked();
});

// ---------------------------------------------------------------------------
// 5. Password gate and wrong-password handling
// ---------------------------------------------------------------------------
test("5. chat is password-protected and handles a wrong password cleanly", async ({ page }) => {
	await openDashboard(page, { savePassword: false });
	await page.selectOption("#chatModel", "haiku");
	const question = "Give me one headline from the AI Swarm topic.";
	const savedPassword = () => page.evaluate(() => localStorage.getItem("newsAgentPassword"));

	// First use asks for the password; a wrong one is rejected by the Worker.
	await page.fill("#chatInput", question);
	await page.press("#chatInput", "Enter");
	await expect(page.locator("#passwordDialog")).toBeVisible();
	const rejected = nextChatExchange(page);
	await page.fill("#passwordInput", "definitely-wrong-password");
	await page.click('#passwordForm button[type="submit"]');
	const bad = await rejected;
	expect(bad.status).toBe(401);
	await expect(page.locator(".msg.error")).toContainText("Wrong password");
	await expect(page.locator(".msg.assistant")).toHaveCount(0);
	await expect(page.locator("#chatInput")).toHaveValue(question);
	expect(await savedPassword()).toBeNull();

	// Correct password: answer arrives and the password is remembered.
	await page.press("#chatInput", "Enter");
	await expect(page.locator("#passwordDialog")).toBeVisible();
	const accepted = nextChatExchange(page);
	await page.fill("#passwordInput", PASSWORD);
	await page.click('#passwordForm button[type="submit"]');
	const good = await accepted;
	expect(good.status).toBe(200);
	await expect(page.locator(".msg.assistant")).toHaveCount(1, { timeout: ANSWER_TIMEOUT });
	expect(await savedPassword()).toBe(PASSWORD);

	// Next question: no prompt, password sent automatically (intercepted, no Claude call).
	let sentHeader;
	await page.route("**/chat", (route) => {
		sentHeader = route.request().headers()["x-agent-password"];
		route.fulfill({
			status: 200,
			headers: { "Access-Control-Allow-Origin": "*" },
			json: { answer: "ok", model: "claude-haiku-5-5", sources: [], context: { articles_considered: 0, article_context_tokens: 0 }, web_search: { enabled: false, searches: 0, queries: [], sources: [] }, usage: { input_tokens: 1, output_tokens: 1 } },
		});
	});
	await page.fill("#chatInput", "Another question");
	await page.press("#chatInput", "Enter");
	await expect(page.locator(".msg.assistant")).toHaveCount(2);
	await expect(page.locator("#passwordDialog")).toBeHidden();
	expect(sentHeader).toBe(PASSWORD);
});
