"""Shared fixtures for the DocWorm SDK characterization tests.

The suite is hermetic: no config file from the working tree is ever
discovered, and the DOCWORM_* environment variables are cleared, so the
precedence tests fully control every source. Individual tests opt into a
config file by pointing config.CONFIG_SEARCH_PATHS at their own tmp_path.
"""

import pytest

from docworm import DocWorm
from docworm import config


@pytest.fixture(autouse=True)
def isolate_config(monkeypatch):
    monkeypatch.setattr(config, "CONFIG_SEARCH_PATHS", [])
    monkeypatch.delenv("DOCWORM_API_KEY", raising=False)
    monkeypatch.delenv("DOCWORM_URL", raising=False)


@pytest.fixture
def client():
    return DocWorm(api_key="test-key", base_url="https://api.example.test")
