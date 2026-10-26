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
