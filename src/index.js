/**
 * News Intelligence App - backend Worker
 *
 *   GET  /health    service status + timestamp
 *   GET  /agent     run the news pipeline now (also runs daily at 7 AM ET via cron)
 *   GET  /articles  query stored articles (?topic=&from=&to=&source=&min_score=&limit=)
 *
 * Secrets: ANTHROPIC_API_KEY (set with `wrangler secret put ANTHROPIC_API_KEY`)
 * Bindings: DB (D1 database news-db)
 */
import Anthropic from "@anthropic-ai/sdk";

// Opus 5.5 is rate-limited to 0 RPM in this account's Default workspace.
const MODEL = "claude-sonnet-5-5";
const ARTICLES_PER_TOPIC_SEARCH = 5;
const MAX_ARTICLES_PER_TOPIC = 20;
const MAX_PAUSE_CONTINUATIONS = 3;
// Web search's dynamic filtering spends several searches per pass; 5 was too few
// and Claude gave up with an empty list.
const MAX_WEB_SEARCHES = 15;

// Cloudflare cron runs in UTC, so wrangler.jsonc fires at both 11:00 and 12:00 UTC
// and only the run that lands on 7 AM New York time does any work (handles DST).
const LOCAL_TIMEZONE = "America/New_York";
const LOCAL_RUN_HOUR = 7;

// `name` is stored in the database and shown in the dashboard;
// `query` is what Claude searches for.
const TOPICS = [
	{
		name: "AI Swarm",
		query:
			"AI agent swarms and multi-agent AI systems: many coordinated AI agents working together " +
			"(multi-agent orchestration frameworks, agent-to-agent protocols, AI-driven drone or robot swarms, " +
			"and companies or labs shipping swarm-style agent products)",
	},
	{
		name: "Scaling Law",
		query:
			"AI scaling laws: research and industry debate on how model capability scales with compute, " +
			"data, and parameters, including pre-training scaling, test-time / inference compute scaling, " +
			"and claims that scaling is slowing down or continuing",
	},
	{
		name: "Data Center",
		query:
			"AI data centers: hyperscale and GPU data center construction, AI compute clusters, " +
			"power and energy deals for data centers, and data center capital spending by major tech companies",
	},
];

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
	"Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
	});
}

export default {
	async fetch(request, env, ctx) {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		const url = new URL(request.url);
		try {
			switch (url.pathname) {
				case "/":
				case "/health":
					return json({ status: "ok", service: "news-app-backend", timestamp: new Date().toISOString() });
				case "/agent":
					return json(await runAgent(env));
				case "/articles":
					return json(await listArticles(env, url.searchParams));
				default:
					return json({ error: "Not found", endpoints: ["/health", "/agent", "/articles"] }, 404);
			}
		} catch (err) {
			console.error(err);
			return json({ error: err.message ?? String(err) }, 500);
		}
	},

	async scheduled(controller, env, ctx) {
		const localHour = Number(
			new Intl.DateTimeFormat("en-US", {
				timeZone: LOCAL_TIMEZONE,
				hour: "numeric",
				hourCycle: "h23",
			}).format(new Date(controller.scheduledTime)),
		);
		if (localHour !== LOCAL_RUN_HOUR) {
			console.log(`Skipping cron "${controller.cron}": it is ${localHour}:00 in ${LOCAL_TIMEZONE}`);
			return;
		}
		ctx.waitUntil(runAgent(env).then((result) => console.log("Scheduled agent run:", JSON.stringify(result))));
	},
};

// ---------------------------------------------------------------------------
// /agent - search, summarize, store
// ---------------------------------------------------------------------------

async function runAgent(env) {
	if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY secret is not set");
	const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
	const startedAt = new Date().toISOString();

	// Topics are independent, so search them in parallel. One failing topic
	// doesn't stop the others.
	const topics = await Promise.all(
		TOPICS.map(async (topic) => {
			try {
				const articles = await searchTopic(client, topic);
				const { inserted, skipped } = await storeArticles(env, topic.name, articles);
				const removed = await capTopic(env, topic.name);
				return { topic: topic.name, returned: articles.length, inserted, skipped, removed_oldest: removed };
			} catch (err) {
				console.error(`Topic "${topic.name}" failed:`, err);
				return { topic: topic.name, returned: 0, inserted: 0, skipped: 0, removed_oldest: 0, error: err.message ?? String(err) };
			}
		}),
	);

	const { stored } = await env.DB.prepare("SELECT COUNT(*) AS stored FROM articles").first();
	const sum = (key) => topics.reduce((n, t) => n + t[key], 0);
	return {
		inserted: sum("inserted"),
		skipped: sum("skipped"),
		total_returned_by_claude: sum("returned"),
		total_in_database: stored,
		started_at: startedAt,
		finished_at: new Date().toISOString(),
		topics,
	};
}

async function searchTopic(client, topic) {
	const today = new Date();
	const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
	const ymd = (d) => d.toISOString().slice(0, 10);

	const prompt = `Today is ${ymd(today)}. Use web search to find the ${ARTICLES_PER_TOPIC_SEARCH} most recent and significant news articles about the following topic, published between ${ymd(weekAgo)} and ${ymd(today)}:

${topic.query}

Prefer original reporting from reputable outlets over aggregators, and choose distinct stories rather than several articles about the same event. Only include articles you actually found in the search results, with their real URLs. If you find fewer than ${ARTICLES_PER_TOPIC_SEARCH} articles in that window, return the ones you have rather than an empty list.

Respond with ONLY a JSON array (no markdown fences, no commentary) of up to ${ARTICLES_PER_TOPIC_SEARCH} objects with these keys:
- "headline": the article's headline
- "source": the publication name (e.g. "Reuters")
- "date": publication date as YYYY-MM-DD
- "url": the article URL
- "summary": a 2-3 sentence summary of what happened and why it matters
- "relevance_score": integer 1-10 for how significant and on-topic the story is (10 = major development squarely on topic)`;

	const messages = [{ role: "user", content: prompt }];
	let response;
	for (let i = 0; i <= MAX_PAUSE_CONTINUATIONS; i++) {
		response = await client.beta.messages
			.stream({
				model: MODEL,
				max_tokens: 16000,
				output_config: { effort: "medium" },
				// If a safety classifier declines, retry server-side on Anthropic's recommended fallback model.
				betas: ["server-side-fallback-2026-07-01"],
				fallbacks: "default",
				tools: [{ type: "web_search_20260209", name: "web_search", max_uses: MAX_WEB_SEARCHES }],
				messages,
			})
			.finalMessage();

		if (response.stop_reason !== "pause_turn") break;
		// The server-side search loop paused; send the partial turn back and it resumes.
		messages.push({ role: "assistant", content: response.content });
	}

	if (response.stop_reason === "refusal") {
		throw new Error(`Claude declined the request (${response.stop_details?.category ?? "no category"})`);
	}

	// Web search splits Claude's answer into multiple text blocks (around citations),
	// so join every text block before extracting the JSON array.
	const text = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	return parseArticles(text);
}

// The joined text can include Claude's in-between notes before the answer, so take
// the last "[ ... ]" span that parses as a JSON array.
function extractJsonArray(text) {
	const end = text.lastIndexOf("]");
	let start = end === -1 ? -1 : text.lastIndexOf("[", end);
	for (; start !== -1; start = start > 0 ? text.lastIndexOf("[", start - 1) : -1) {
		try {
			const parsed = JSON.parse(text.slice(start, end + 1));
			if (Array.isArray(parsed)) return parsed;
		} catch {
			// not a complete array yet; widen to the previous "["
		}
	}
	throw new Error(`No JSON array found in Claude's response: ${text.slice(0, 300)}`);
}

function parseArticles(text) {
	return extractJsonArray(text)
		.filter((a) => a && typeof a.headline === "string" && /^https?:\/\//.test(a.url ?? ""))
		.map((a) => ({
			headline: a.headline.trim(),
			source: typeof a.source === "string" ? a.source.trim() : null,
			date: /^\d{4}-\d{2}-\d{2}$/.test(a.date ?? "") ? a.date : null,
			url: a.url.trim(),
			summary: typeof a.summary === "string" ? a.summary.trim() : null,
			relevance_score: Math.min(10, Math.max(1, Math.round(Number(a.relevance_score) || 5))),
		}));
}

async function storeArticles(env, topicName, articles) {
	if (articles.length === 0) return { inserted: 0, skipped: 0 };
	// The UNIQUE constraint on url makes INSERT OR IGNORE skip articles we already have.
	const stmt = env.DB.prepare(
		`INSERT OR IGNORE INTO articles (topic, headline, source, publication_date, url, summary, relevance_score)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	const results = await env.DB.batch(
		articles.map((a) => stmt.bind(topicName, a.headline, a.source, a.date, a.url, a.summary, a.relevance_score)),
	);
	const inserted = results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
	return { inserted, skipped: articles.length - inserted };
}

// Keep only the newest MAX_ARTICLES_PER_TOPIC articles for a topic; returns how many were removed.
async function capTopic(env, topicName) {
	const result = await env.DB.prepare(
		`DELETE FROM articles
		 WHERE topic = ?1 AND id NOT IN (
		   SELECT id FROM articles WHERE topic = ?1
		   ORDER BY publication_date DESC, fetched_at DESC, id DESC
		   LIMIT ?2
		 )`,
	)
		.bind(topicName, MAX_ARTICLES_PER_TOPIC)
		.run();
	return result.meta?.changes ?? 0;
}

// ---------------------------------------------------------------------------
// /articles?topic=&from=YYYY-MM-DD&to=YYYY-MM-DD&source=&min_score=&limit=
// ---------------------------------------------------------------------------

async function listArticles(env, params) {
	const where = [];
	const binds = [];
	const add = (clause, value) => {
		where.push(clause);
		binds.push(value);
	};

	if (params.get("topic")) add("topic = ?", params.get("topic"));
	if (params.get("from")) add("publication_date >= ?", params.get("from"));
	if (params.get("to")) add("publication_date <= ?", params.get("to"));
	if (params.get("source")) add("source LIKE ?", `%${params.get("source")}%`);
	const minScore = Number(params.get("min_score"));
	if (minScore) add("relevance_score >= ?", minScore);
	const limit = Math.min(200, Math.max(1, Number(params.get("limit")) || 50));

	const { results } = await env.DB.prepare(
		`SELECT id, topic, headline, source, publication_date, url, summary, relevance_score, fetched_at
		 FROM articles
		 ${where.length ? "WHERE " + where.join(" AND ") : ""}
		 ORDER BY publication_date DESC, relevance_score DESC, id DESC
		 LIMIT ?`,
	)
		.bind(...binds, limit)
		.all();
	const { last_refreshed } = await env.DB.prepare("SELECT MAX(fetched_at) AS last_refreshed FROM articles").first();

	return {
		count: results.length,
		last_refreshed,
		topics: TOPICS.map((t) => t.name),
		articles: results,
	};
}
