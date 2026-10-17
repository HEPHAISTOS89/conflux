from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Iterator

import pytest

FIXTURES = Path(__file__).parent / "fixtures"
os.environ["CURATED_DIR"] = str(FIXTURES)
os.environ.pop("DATA_BUCKET", None)
os.environ.pop("AWS_LAMBDA_FUNCTION_NAME", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app import ask, store  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture()
def client() -> Iterator[TestClient]:
    store.clear_cache()
    ask.bucket._state.clear()
    yield TestClient(app)


@pytest.fixture()
def no_bedrock(monkeypatch: pytest.MonkeyPatch) -> None:
    class Boom:
        def converse(self, **_: object) -> None:
            raise RuntimeError("AccessDeniedException: account is being verified")

    monkeypatch.setenv("BEDROCK_MODEL_ID", "us.anthropic.claude-haiku-4-5")
    monkeypatch.setattr(ask, "_bedrock", lambda: Boom())
