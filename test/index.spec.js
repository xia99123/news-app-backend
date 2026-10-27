import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("news-app-backend worker", () => {
	it("GET /health returns ok with a timestamp and CORS headers", async () => {
		const response = await SELF.fetch("http://example.com/health");
		expect(response.status).toBe(200);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		const body = await response.json();
		expect(body.status).toBe("ok");
		expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
	});

	it("OPTIONS preflight returns 204 with CORS headers", async () => {
		const response = await SELF.fetch("http://example.com/articles", { method: "OPTIONS" });
		expect(response.status).toBe(204);
		expect(response.headers.get("Access-Control-Allow-Methods")).toContain("GET");
	});

	it("unknown paths return 404 JSON", async () => {
		const response = await SELF.fetch("http://example.com/nope");
		expect(response.status).toBe(404);
		expect((await response.json()).error).toBe("Not found");
	});
});

describe("authenticated external triggers", () => {
	it("POST /trigger without a token is rejected", async () => {
		const response = await SELF.fetch("http://example.com/trigger", { method: "POST" });
		expect(response.status).toBe(401);
	});

	it("POST /trigger with a wrong token is rejected", async () => {
		const response = await SELF.fetch("http://example.com/trigger", {
			method: "POST",
			headers: { Authorization: "Bearer not-the-real-token" },
		});
		expect(response.status).toBe(401);
	});

	it("GET /trigger/<id> without a token is rejected", async () => {
		const response = await SELF.fetch("http://example.com/trigger/some-run-id");
		expect(response.status).toBe(401);
	});

	it("GET /trigger is not allowed", async () => {
		const response = await SELF.fetch("http://example.com/trigger");
		expect(response.status).toBe(405);
	});

	it("POST /slack/command with a bad signature is rejected", async () => {
		const response = await SELF.fetch("http://example.com/slack/command", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"X-Slack-Request-Timestamp": String(Math.floor(Date.now() / 1000)),
				"X-Slack-Signature": "v0=deadbeef",
			},
			body: "command=%2Fnews&text=",
		});
		expect(response.status).toBe(401);
		expect((await response.json()).error).toBe("Invalid Slack signature");
	});

	it("POST /slack/command with a stale timestamp is rejected", async () => {
		const response = await SELF.fetch("http://example.com/slack/command", {
			method: "POST",
			headers: { "X-Slack-Request-Timestamp": String(Math.floor(Date.now() / 1000) - 3600), "X-Slack-Signature": "v0=x" },
			body: "command=%2Fnews",
		});
		expect(response.status).toBe(401);
	});
});

describe("password-protected pipeline endpoint", () => {
	it("/agent without a password is rejected", async () => {
		const response = await SELF.fetch("http://example.com/agent", { method: "POST" });
		expect(response.status).toBe(401);
		expect((await response.json()).error).toMatch(/X-Agent-Password/);
	});

	it("/agent with a wrong password is rejected", async () => {
		const response = await SELF.fetch("http://example.com/agent", {
			method: "POST",
			headers: { "X-Agent-Password": "wrong-password" },
		});
		expect(response.status).toBe(401);
	});

	it("CORS preflight allows the X-Agent-Password header", async () => {
		const response = await SELF.fetch("http://example.com/agent", { method: "OPTIONS" });
		expect(response.headers.get("Access-Control-Allow-Headers")).toContain("X-Agent-Password");
	});

	it("/health and /articles stay public", async () => {
		expect((await SELF.fetch("http://example.com/health")).status).toBe(200);
		expect((await SELF.fetch("http://example.com/articles")).status).not.toBe(401);
	});
});
