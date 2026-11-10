"""Sphinx configuration for the docworm Python SDK API reference."""

import os
import sys

# Make the SDK importable when the build is run from the repository root.
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SDK_PATH = os.path.join(REPO_ROOT, "python")
if SDK_PATH not in sys.path:
    sys.path.insert(0, SDK_PATH)

project = "docworm"
copyright = "Hopperbase"
author = "Hopperbase"

extensions = [
    "sphinx.ext.autodoc",
    "sphinx.ext.napoleon",
]

autodoc_typehints = "signature"
autodoc_member_order = "bysource"
smartquotes = False

exclude_patterns = ["_build"]


def _normalize_docstrings(app, what, name, obj, options, lines):
    """Normalize SDK docstrings before Napoleon and autodoc render them."""
    for index, line in enumerate(lines):
        lines[index] = line.replace("dw_live_", "dw\\_live\\_")

    if name in ("docworm.client.DocWorm", "docworm.DocWorm"):
        # A literal ``Usage::`` header (followed by a blank line) turns the
        # indented usage lines into a code block instead of a collapsed
        # paragraph.
        index = 0
        while index < len(lines):
            if lines[index].strip() == "Usage:":
                lines[index] = lines[index].replace("Usage:", "Usage::")
                if index + 1 < len(lines) and lines[index + 1].strip():
                    lines.insert(index + 1, "")
                index += 2
                continue
            index += 1

    if name.endswith("UsageInfo"):
        # Autodoc already documents every dataclass field, so Napoleon's
        # ``Attributes:`` block would render each field twice.
        start = None
        for index, line in enumerate(lines):
            if line.strip() == "Attributes:":
                start = index
                break
        if start is not None:
            end = start + 1
            while end < len(lines) and (
                not lines[end].strip() or lines[end].startswith((" ", "\t"))
            ):
                end += 1
            del lines[start:end]


def setup(app):
    # Run before Napoleon (priority 500) so the literal docstring sections are
    # still unprocessed when this handler inspects them.
    app.connect("autodoc-process-docstring", _normalize_docstrings, priority=400)
    return {"parallel_read_safe": True, "parallel_write_safe": True}
