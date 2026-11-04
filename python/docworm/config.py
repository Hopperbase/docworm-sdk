"""
DocWorm SDK Configuration.

Loads config from, in priority order (highest first):
  1. Constructor arguments (api_key, base_url)
  2. Environment variables (DOCWORM_API_KEY, DOCWORM_URL)
  3. config.yaml in standard locations

The config file is optional — for most users, just pass api_key to the constructor
or set DOCWORM_API_KEY env var.

Auth accepts a DocWorm API key (dw_live_...), sent as ``X-API-KEY``, or a
bearer token, sent as ``Authorization: Bearer``.
"""

import os
from pathlib import Path
from typing import Any, Optional


CONFIG_FILENAME = "config.yaml"

CONFIG_SEARCH_PATHS = [
    Path.cwd() / CONFIG_FILENAME,
    Path.home() / ".config" / "docworm" / CONFIG_FILENAME,
    Path(os.getenv("XDG_CONFIG_HOME", Path.home() / ".config")) / "docworm" / CONFIG_FILENAME,
    Path(__file__).parent.parent.parent / CONFIG_FILENAME,
]


def _find_config_file() -> Optional[Path]:
    for p in CONFIG_SEARCH_PATHS:
        if p.exists():
            return p
    return None


def _load_yaml_config(path: Path) -> dict:
    try:
        import yaml
    except ImportError:
        return _load_simple_config(path)
    try:
        with open(path) as f:
            return yaml.safe_load(f) or {}
    except Exception:
        return {}


def _load_simple_config(path: Path) -> dict:
    """
    Minimal key: value parser for config.yaml without the yaml dependency.
    Only handles simple key: value pairs at the top level.
    """
    config = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if ":" in line:
                    key, _, value = line.partition(":")
                    key = key.strip()
                    value = value.strip().strip('"').strip("'")
                    if value and not value.startswith("${"):
                        config[key] = value
    except Exception:
        pass
    return config


def load_config(
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
) -> dict:
    """
    Load SDK config from all sources (constructor > env > file).

    Returns a dict with keys: api_key, base_url
    """
    result: dict[str, Any] = {}

    # 1. Config file
    config_path = _find_config_file()
    if config_path:
        file_config = _load_yaml_config(config_path)
        if file_config:
            result["api_key"] = file_config.get("api_key", "")
            result["base_url"] = file_config.get("base_url", "")

    # 2. Environment variables (override file)
    env_api_key = os.getenv("DOCWORM_API_KEY")
    env_base_url = os.getenv("DOCWORM_URL")
    if env_api_key:
        result["api_key"] = env_api_key
    if env_base_url:
        result["base_url"] = env_base_url

    # 3. Constructor arguments (override everything)
    if api_key is not None:
        result["api_key"] = api_key
    if base_url is not None:
        result["base_url"] = base_url

    # Defaults
    result.setdefault("api_key", "")
    result.setdefault("base_url", "https://docworm.web.app")

    return result
