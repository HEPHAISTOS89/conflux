.PHONY: test api-test web-build
api-test:
	cd services/api && python3 -m pytest -q
web-build:
	cd apps/web && npm run build

smoke-api:
	./scripts/smoke_api.sh $${API_BASE_URL:-http://127.0.0.1:8000}
smoke-web:
	./scripts/smoke_web.sh $${WEB_URL:-http://127.0.0.1:5173}
