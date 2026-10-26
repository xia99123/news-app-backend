-- News Intelligence App: articles table
CREATE TABLE IF NOT EXISTS articles (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  topic            TEXT    NOT NULL,
  headline         TEXT    NOT NULL,
  source           TEXT,
  publication_date TEXT,                 -- ISO date, YYYY-MM-DD
  url              TEXT    NOT NULL UNIQUE,
  summary          TEXT,                 -- AI-generated summary
  relevance_score  INTEGER CHECK (relevance_score BETWEEN 1 AND 10),
  fetched_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_articles_topic_date ON articles (topic, publication_date DESC);
CREATE INDEX IF NOT EXISTS idx_articles_relevance ON articles (relevance_score);
