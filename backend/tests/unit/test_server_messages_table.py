"""Every error the fork's endpoints send has a translation in the frontend's table.

The API keeps its English ``detail`` strings (tests, PRODUCTS_API.md and API
users rely on them); the frontend turns them into the user's language through
``frontend/src/api/serverMessages.json``. This scan fails when a fork module
raises a message the table does not know, so a new or reworded error cannot
reach a Polish screen in English unnoticed.
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
APP = REPO / "backend" / "app"
TABLE = REPO / "frontend" / "src" / "api" / "serverMessages.json"

# Whole fork modules.
MODULES = [
    "api/routes/products.py",
    "api/routes/base_sync.py",
    "api/routes/slot_spools.py",
    "api/routes/octoprint_compat.py",
    "api/routes/printer_tags.py",
    "api/routes/filament_aliases.py",
    "services/products.py",
    "services/product_planner.py",
    "services/product_filament.py",
    "services/base_sync.py",
    "services/queue_plan.py",
    "services/queue_reservations.py",
    "services/queue_forecast.py",
    "services/staffed_hours.py",
    "services/slot_spools.py",
    "services/printer_tags.py",
    "services/filament_aliases.py",
    "services/plate_clears.py",
    "services/plate_history.py",
    "schemas/queue_forecast.py",
]
# print_queue.py is upstream: only the fork's endpoints in it.
PRINT_QUEUE_FORK_FUNCTIONS = {
    "queue_forecast",
    "get_staffed_hours",
    "put_staffed_hours",
    "apply_queue_plan",
    "release_queue_reservation",
}
EXCEPTIONS = {"HTTPException", "PlanError", "SlotSpoolError", "ValueError", "BaseApiError", "ThumbnailError"}
SAMPLE = "7"  # stands in for every {value} of an f-string


def _samples(node: ast.AST) -> list[str] | None:
    """The texts a message expression can produce, or None when it is not literal text."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, ast.JoinedStr):
        return ["".join(v.value if isinstance(v, ast.Constant) else SAMPLE for v in node.values)]
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _samples(node.left), _samples(node.right)
        if left is None or right is None:
            return None
        return [a + b for a in left for b in right]
    if isinstance(node, ast.IfExp):
        body, orelse = _samples(node.body), _samples(node.orelse)
        if body is None or orelse is None:
            return None
        return body + orelse
    return None


def _message_node(call: ast.Call) -> ast.AST | None:
    for kw in call.keywords:
        if kw.arg in ("detail", "message"):
            return kw.value
    for arg in call.args:
        if _samples(arg) is not None:
            return arg
    return None


def _raised_messages(tree: ast.AST) -> list[tuple[int, str]]:
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else ""
        if name not in EXCEPTIONS:
            continue
        message = _message_node(node)
        samples = _samples(message) if message is not None else None
        for sample in samples or []:
            found.append((node.lineno, sample))
    return found


def collect_messages() -> list[tuple[str, int, str]]:
    out = []
    for module in MODULES:
        tree = ast.parse((APP / module).read_text())
        out += [(module, line, text) for line, text in _raised_messages(tree)]
    tree = ast.parse((APP / "api/routes/print_queue.py").read_text())
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in PRINT_QUEUE_FORK_FUNCTIONS:
            out += [("api/routes/print_queue.py", line, text) for line, text in _raised_messages(node)]
    return out


def _python_regex(pattern: str) -> re.Pattern[str]:
    # The table is written for JavaScript: (?<name>...) is (?P<name>...) here.
    return re.compile(re.sub(r"\(\?<(?![=!])", "(?P<", pattern))


def _load_table():
    table = json.loads(TABLE.read_text())
    exact = {e["text"] for e in table["errors"] if "text" in e}
    # Shown as they come; listed by the scan's sample so each is a decision.
    exact |= {e["sample"] for e in table["passThrough"]}
    patterns = [_python_regex(e["pattern"]) for e in table["errors"] if "pattern" in e]
    return exact, patterns


def test_the_scan_finds_the_fork_errors():
    texts = {text for _, _, text in collect_messages()}
    # A few known ones, so a broken scan cannot pass by finding nothing.
    assert "Only an open order can be cancelled" in texts
    assert "The plate was moved by hand: it stays where it was put" in texts
    assert f"Job {SAMPLE} cannot be held for printer {SAMPLE}: {SAMPLE} ({SAMPLE})" in texts
    assert "Shortest job first sets the queue order, so it cannot be planned" in texts


def test_every_fork_error_is_in_the_table():
    exact, patterns = _load_table()
    missing = sorted(
        {
            f"{module}:{line}: {text}"
            for module, line, text in collect_messages()
            if text not in exact and not any(p.fullmatch(text) for p in patterns)
        }
    )
    assert not missing, (
        "These errors have no entry in frontend/src/api/serverMessages.json "
        "(add one, and its pl/en text in frontend/src/i18n/serverMessages):\n" + "\n".join(missing)
    )


def test_table_patterns_are_anchored_and_compile():
    table = json.loads(TABLE.read_text())
    for entry in table["errors"]:
        assert ("text" in entry) != ("pattern" in entry), entry
        assert entry["key"], entry
        if "pattern" in entry:
            assert entry["pattern"].startswith("^") and entry["pattern"].endswith("$"), entry
            _python_regex(entry["pattern"])
