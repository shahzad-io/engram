up:
	docker compose up -d

down:
	docker compose down

fresh:
	docker compose down -v && docker compose up -d --wait && npm run migrate

migrate:
	node dist/cli.js migrate

triage:
	node dist/cli.js triage

backfill:
	node dist/cli.js backfill --dry-run backfill/mira

serve:
	node dist/cli.js serve --http --host 127.0.0.1 --port 8377

test:
	npm test

.PHONY: up down fresh migrate triage backfill serve test
