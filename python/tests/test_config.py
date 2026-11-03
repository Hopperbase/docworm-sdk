"""Characterization tests for docworm.config.

The loader has no yaml hard dependency: when PyYAML is absent (it is not a
declared dependency) _load_simple_config is the parser in use. These tests
pin the precedence order, the raw-value passthrough, and the exact quirks of
the hand-rolled parser.
"""

import pytest

from docworm import config
from docworm.client import DocWorm
from docworm.config import (
    _find_config_file,
    _load_simple_config,
    load_config,
)


def _write_config(tmp_path, text):
    path = tmp_path / "config.yaml"
    path.write_text(text, encoding="ascii")
    return path


# ---------------------------------------------------------------------------
# Precedence: constructor > env > file > default
# ---------------------------------------------------------------------------


def test_defaults_when_no_source_is_present():
    assert load_config() == {
        "api_key": "",
        "base_url": "https://docworm.web.app",
    }


def test_environment_overrides_defaults(monkeypatch):
    monkeypatch.setenv("DOCWORM_API_KEY", "env-key")
    monkeypatch.setenv("DOCWORM_URL", "https://env.example.test")
    assert load_config() == {
        "api_key": "env-key",
        "base_url": "https://env.example.test",
    }


def test_constructor_overrides_environment(monkeypatch):
    monkeypatch.setenv("DOCWORM_API_KEY", "env-key")
    monkeypatch.setenv("DOCWORM_URL", "https://env.example.test")
    assert load_config(
        api_key="ctor-key",
        base_url="https://ctor.example.test",
    ) == {
        "api_key": "ctor-key",
        "base_url": "https://ctor.example.test",
    }


def test_file_values_are_used_without_env_or_constructor(monkeypatch, tmp_path):
    path = _write_config(
        tmp_path,
        "api_key: file-key\nbase_url: https://file.example.test\n",
    )
    monkeypatch.setattr(config, "CONFIG_SEARCH_PATHS", [path])
    assert load_config() == {
        "api_key": "file-key",
        "base_url": "https://file.example.test",
    }


def test_environment_overrides_file(monkeypatch, tmp_path):
    path = _write_config(
        tmp_path,
        "api_key: file-key\nbase_url: https://file.example.test\n",
    )
    monkeypatch.setattr(config, "CONFIG_SEARCH_PATHS", [path])
    monkeypatch.setenv("DOCWORM_API_KEY", "env-key")
    monkeypatch.setenv("DOCWORM_URL", "https://env.example.test")
    assert load_config() == {
        "api_key": "env-key",
        "base_url": "https://env.example.test",
    }


def test_constructor_overrides_file_and_environment(monkeypatch, tmp_path):
    path = _write_config(
        tmp_path,
        "api_key: file-key\nbase_url: https://file.example.test\n",
    )
    monkeypatch.setattr(config, "CONFIG_SEARCH_PATHS", [path])
    monkeypatch.setenv("DOCWORM_API_KEY", "env-key")
    monkeypatch.setenv("DOCWORM_URL", "https://env.example.test")
    assert load_config(
        api_key="ctor-key",
        base_url="https://ctor.example.test",
    ) == {
        "api_key": "ctor-key",
        "base_url": "https://ctor.example.test",
    }


# ---------------------------------------------------------------------------
# config returns values exactly as parsed; the client does the slash strip
# ---------------------------------------------------------------------------


def test_config_does_not_strip_trailing_slashes(monkeypatch, tmp_path):
    path = _write_config(
        tmp_path,
        "api_key: file-key\nbase_url: https://file.example.test///\n",
    )
    monkeypatch.setattr(config, "CONFIG_SEARCH_PATHS", [path])
    assert load_config()["base_url"] == "https://file.example.test///"


def test_env_and_constructor_values_are_returned_unstripped(monkeypatch):
    monkeypatch.setenv("DOCWORM_URL", "https://env.example.test///")
    assert load_config()["base_url"] == "https://env.example.test///"
    assert (
        load_config(base_url="https://ctor.example.test///")["base_url"]
        == "https://ctor.example.test///"
    )


def test_client_strips_all_trailing_slashes_after_config():
    # The strip lives in DocWorm.__init__, not in load_config.
    assert DocWorm(base_url="https://ctor.example.test///").base_url == (
        "https://ctor.example.test"
    )


# ---------------------------------------------------------------------------
# Known quirk: a partial config file blocks the base_url default
# ---------------------------------------------------------------------------


def test_partial_file_with_only_api_key_yields_empty_base_url(monkeypatch, tmp_path):
    # load_config seeds result["base_url"] = "" from the file and then
    # setdefault() cannot replace the existing empty value.
    path = _write_config(tmp_path, "api_key: file-key\n")
    monkeypatch.setattr(config, "CONFIG_SEARCH_PATHS", [path])
    assert load_config() == {"api_key": "file-key", "base_url": ""}


def test_partial_file_with_only_base_url_yields_empty_api_key(monkeypatch, tmp_path):
    path = _write_config(tmp_path, "base_url: https://file.example.test\n")
    monkeypatch.setattr(config, "CONFIG_SEARCH_PATHS", [path])
    assert load_config() == {
        "api_key": "",
        "base_url": "https://file.example.test",
    }


# ---------------------------------------------------------------------------
# _find_config_file
# ---------------------------------------------------------------------------


def test_find_config_file_returns_none_for_empty_search_paths():
    assert _find_config_file() is None


def test_find_config_file_returns_first_existing_path(monkeypatch, tmp_path):
    missing = tmp_path / "missing.yaml"
    present = _write_config(tmp_path, "api_key: file-key\n")
    monkeypatch.setattr(config, "CONFIG_SEARCH_PATHS", [missing, present])
    assert _find_config_file() == present


# ---------------------------------------------------------------------------
# The hand-rolled key:value parser
# ---------------------------------------------------------------------------


def test_simple_parser_trims_whitespace(tmp_path):
    path = _write_config(tmp_path, "  api_key :   spaced-key   \n")
    assert _load_simple_config(path) == {"api_key": "spaced-key"}


def test_simple_parser_strips_double_quotes(tmp_path):
    path = _write_config(tmp_path, 'api_key: "quoted-key"\n')
    assert _load_simple_config(path) == {"api_key": "quoted-key"}


def test_simple_parser_strips_single_quotes(tmp_path):
    path = _write_config(tmp_path, "base_url: 'https://quoted.example.test'\n")
    assert _load_simple_config(path) == {
        "base_url": "https://quoted.example.test"
    }


def test_simple_parser_skips_comments_and_blank_lines(tmp_path):
    path = _write_config(
        tmp_path,
        "# a comment\n"
        "\n"
        "   \n"
        "  # an indented comment\n"
        "api_key: real-key\n",
    )
    assert _load_simple_config(path) == {"api_key": "real-key"}


def test_simple_parser_skips_lines_without_a_colon(tmp_path):
    path = _write_config(
        tmp_path,
        "not-a-pair\n"
        "api_key: real-key\n",
    )
    assert _load_simple_config(path) == {"api_key": "real-key"}


def test_simple_parser_handles_colons_inside_the_value(tmp_path):
    path = _write_config(tmp_path, "base_url: https://x.example.test:8443\n")
    assert _load_simple_config(path) == {
        "base_url": "https://x.example.test:8443"
    }


def test_simple_parser_keeps_the_first_colon_split(tmp_path):
    path = _write_config(tmp_path, "api_key: a:b:c\n")
    assert _load_simple_config(path) == {"api_key": "a:b:c"}


def test_simple_parser_skips_empty_values(tmp_path):
    path = _write_config(
        tmp_path,
        'api_key: ""\n'
        "base_url: https://file.example.test\n",
    )
    assert _load_simple_config(path) == {
        "base_url": "https://file.example.test"
    }


def test_simple_parser_skips_environment_references(tmp_path):
    path = _write_config(
        tmp_path,
        "api_key: ${DOCWORM_API_KEY}\n"
        "base_url: https://file.example.test\n",
    )
    assert _load_simple_config(path) == {
        "base_url": "https://file.example.test"
    }


def test_simple_parser_does_not_handle_inline_comments(tmp_path):
    # Quirk: '#' after a value is data, not a comment. Here the value stays
    # quoted-with-trailing-text because strip('"') only bites at the ends.
    path = _write_config(
        tmp_path,
        'base_url: "https://file.example.test"  # hosted\n',
    )
    assert _load_simple_config(path) == {
        "base_url": 'https://file.example.test"  # hosted'
    }


def test_simple_parser_returns_empty_dict_for_missing_file(tmp_path):
    assert _load_simple_config(tmp_path / "nope.yaml") == {}


@pytest.mark.parametrize(
    "text",
    [
        "api_key: plain\n",
        'api_key: "double"\n',
        "api_key: 'single'\n",
    ],
)
def test_simple_parser_quoted_forms_agree(tmp_path, text):
    value = _load_simple_config(_write_config(tmp_path, text))["api_key"]
    assert value in {"plain", "double", "single"}
