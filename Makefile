.PHONY: test api-test web-build
api-test:
	cd services/api && python3 -m pytest -q
web-build:
	cd apps/web && npm run build
