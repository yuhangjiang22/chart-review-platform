"""Tiny recursive-descent evaluator for the platform's derivation dialect.

Grammar (loosely):
    expr        := ternary
    ternary     := or_expr ('?' ternary ':' ternary)?
                 | IF or_expr THEN ternary (ELSE ternary)?
    or_expr     := and_expr (OR and_expr)*
    and_expr    := not_expr (AND not_expr)*
    not_expr    := NOT not_expr | comparison
    comparison  := addition (CMP addition | 'in' addition)?
    addition    := multiplication (('+'|'-') multiplication)*
    multiplication := unary (('*'|'/') unary)*
    unary       := '-' unary | primary
    primary     := '(' ternary ')' | call | literal | identifier
    call        := identifier '(' (expr (',' expr)*)? ')'
    literal     := string | number | bool | list_literal
    list_literal:= '[' (expr (',' expr)*)? ']'

Strings: '...' or "...".  Booleans: true/false (case-insensitive).  Numbers: int/float.
Identifiers are looked up in the provided env. Comparators: == != > >= < <=

Arithmetic: + - * / on numbers. Any null operand yields null.
Division by zero returns null.

Builtins:
    count_true([expr, expr, ...])          -> integer count of truthy operands;
                                              null operands are skipped (not counted false).
    days_between(d_iso, d_iso) -> integer  -> days from d2 to d1 (d1 - d2);
                                              dates are YYYY-MM-DD strings;
                                              null on null operand or parse failure.

NOT a Python eval — pure interpreter. No attribute access, no imports, no
arbitrary calls; only the named builtins above are callable.
"""

from __future__ import annotations

import datetime as _dt
import re
from typing import Any


_TOKEN_RE = re.compile(
    r"""
    \s+                             |   # whitespace
    (?P<STR>'[^']*'|"[^"]*")        |   # string literal
    (?P<NUM>\d+(?:\.\d+)?)          |   # number (unsigned; unary minus is parsed)
    (?P<OP>==|!=|>=|<=|>|<|\?|:|,|\(|\)|\[|\]|\+|\-|\*|\/)  |   # operator/punctuation
    (?P<ID>[A-Za-z_][A-Za-z_0-9]*)  |   # identifier or keyword
    """,
    re.VERBOSE,
)

_KEYWORDS = {"AND", "OR", "NOT", "IN", "IF", "THEN", "ELSE"}


def _tokenize(expr: str) -> list[tuple[str, str]]:
    tokens: list[tuple[str, str]] = []
    pos = 0
    while pos < len(expr):
        m = _TOKEN_RE.match(expr, pos)
        if not m or m.end() == pos:
            raise ValueError(f"Unexpected character at offset {pos}: {expr[pos]!r}")
        if m.group("STR"):
            tokens.append(("STR", m.group("STR")[1:-1]))
        elif m.group("NUM"):
            tokens.append(("NUM", m.group("NUM")))
        elif m.group("OP"):
            tokens.append(("OP", m.group("OP")))
        elif m.group("ID"):
            ident = m.group("ID")
            up = ident.upper()
            if up in _KEYWORDS:
                tokens.append(("KW", up))
            elif ident.lower() == "true":
                tokens.append(("BOOL", True))
            elif ident.lower() == "false":
                tokens.append(("BOOL", False))
            elif ident.lower() == "null":
                tokens.append(("NULL", None))
            else:
                tokens.append(("ID", ident))
        # whitespace is skipped
        pos = m.end()
    return tokens


class _Parser:
    def __init__(self, tokens: list[tuple[str, str]]):
        self.tokens = tokens
        self.pos = 0

    def _peek(self, offset: int = 0):
        i = self.pos + offset
        return self.tokens[i] if i < len(self.tokens) else (None, None)

    def _eat(self):
        tok = self._peek()
        self.pos += 1
        return tok

    def _accept(self, kind: str, value=None) -> bool:
        k, v = self._peek()
        if k == kind and (value is None or v == value):
            self._eat()
            return True
        return False

    def _expect(self, kind: str, value=None):
        if not self._accept(kind, value):
            k, v = self._peek()
            raise ValueError(f"Expected {kind}={value!r}, got {k}={v!r}")

    def parse(self):
        node = self._ternary()
        if self.pos != len(self.tokens):
            k, v = self._peek()
            raise ValueError(f"Unexpected trailing token: {k}={v!r}")
        return node

    def _ternary(self):
        # Support both `if cond then a else b` and `cond ? a : b` forms.
        if self._accept("KW", "IF"):
            cond = self._or()
            self._expect("KW", "THEN")
            then_branch = self._ternary()
            if self._accept("KW", "ELSE"):
                else_branch = self._ternary()
            else:
                else_branch = ("const", None)
            return ("if", cond, then_branch, else_branch)
        cond = self._or()
        if self._accept("OP", "?"):
            then_branch = self._ternary()
            self._expect("OP", ":")
            else_branch = self._ternary()
            return ("if", cond, then_branch, else_branch)
        return cond

    def _or(self):
        node = self._and()
        while self._accept("KW", "OR"):
            right = self._and()
            node = ("or", node, right)
        return node

    def _and(self):
        node = self._not()
        while self._accept("KW", "AND"):
            right = self._not()
            node = ("and", node, right)
        return node

    def _not(self):
        if self._accept("KW", "NOT"):
            return ("not", self._not())
        return self._comparison()

    def _comparison(self):
        left = self._addition()
        k, v = self._peek()
        if k == "OP" and v in ("==", "!=", ">", ">=", "<", "<="):
            self._eat()
            right = self._addition()
            return ("cmp", v, left, right)
        if k == "KW" and v == "IN":
            self._eat()
            right = self._addition()  # list literal expected
            return ("in", left, right)
        return left

    def _addition(self):
        node = self._multiplication()
        while True:
            k, v = self._peek()
            if k == "OP" and v in ("+", "-"):
                self._eat()
                right = self._multiplication()
                node = ("arith", v, node, right)
            else:
                return node

    def _multiplication(self):
        node = self._unary()
        while True:
            k, v = self._peek()
            if k == "OP" and v in ("*", "/"):
                self._eat()
                right = self._unary()
                node = ("arith", v, node, right)
            else:
                return node

    def _unary(self):
        if self._accept("OP", "-"):
            return ("neg", self._unary())
        return self._primary()

    def _primary(self):
        k, v = self._peek()
        if k == "OP" and v == "(":
            self._eat()
            inner = self._ternary()
            self._expect("OP", ")")
            return inner
        if k == "OP" and v == "[":
            self._eat()
            items = []
            if not self._accept("OP", "]"):
                items.append(self._ternary())
                while self._accept("OP", ","):
                    items.append(self._ternary())
                self._expect("OP", "]")
            return ("list", items)
        if k == "STR":
            self._eat()
            return ("const", v)
        if k == "NUM":
            self._eat()
            n = v
            return ("const", float(n) if "." in n else int(n))
        if k == "BOOL":
            self._eat()
            return ("const", v)
        if k == "NULL":
            self._eat()
            return ("const", None)
        if k == "ID":
            self._eat()
            # Builtin call: identifier followed immediately by '('.
            kk, vv = self._peek()
            if kk == "OP" and vv == "(":
                self._eat()
                args = []
                if not self._accept("OP", ")"):
                    args.append(self._ternary())
                    while self._accept("OP", ","):
                        args.append(self._ternary())
                    self._expect("OP", ")")
                return ("call", v, args)
            return ("name", v)
        raise ValueError(f"Unexpected token in primary: {k}={v!r}")


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _parse_iso_date(value: Any) -> _dt.date | None:
    if not isinstance(value, str) or not _DATE_RE.match(value):
        return None
    try:
        return _dt.date.fromisoformat(value)
    except ValueError:
        return None


def _builtin_count_true(args: list[Any]) -> int:
    if len(args) != 1 or not isinstance(args[0], list):
        raise ValueError("count_true expects a single list argument")
    return sum(1 for x in args[0] if x is not None and bool(x))


def _builtin_days_between(args: list[Any]) -> int | None:
    if len(args) != 2:
        raise ValueError("days_between expects exactly 2 arguments")
    a, b = args
    if a is None or b is None:
        return None
    da = _parse_iso_date(a)
    db = _parse_iso_date(b)
    if da is None or db is None:
        return None
    return (da - db).days


_BUILTINS = {
    "count_true": _builtin_count_true,
    "days_between": _builtin_days_between,
}


def _canonical_bool(v: Any) -> Any:
    """Normalize boolean-equivalent values so the evaluator treats
    ``True`` / ``"true"`` / ``"yes"`` interchangeably (and the false
    counterparts likewise). Mirrors the ``_canonicalBoolLit`` helper in
    contract-eval.ts and the normalizer in disagreements.ts so the
    disagreement extractor and the derivation evaluator agree on
    equality. Other strings (e.g. ``"nsclc"``, ``"no_info"``) and
    non-bool/non-string values pass through unchanged.
    """
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        lc = v.strip().lower()
        if lc in ("yes", "true"):
            return "true"
        if lc in ("no", "false"):
            return "false"
    return v


def _eval_node(node, env: dict[str, Any]) -> Any:
    op = node[0]
    if op == "const":
        return node[1]
    if op == "name":
        if node[1] not in env:
            raise NameError(f"Unknown identifier: {node[1]}")
        return env[node[1]]
    if op == "list":
        return [_eval_node(x, env) for x in node[1]]
    if op == "and":
        a = _eval_node(node[1], env)
        if not a:
            return a
        return _eval_node(node[2], env)
    if op == "or":
        a = _eval_node(node[1], env)
        if a:
            return a
        return _eval_node(node[2], env)
    if op == "not":
        return not _eval_node(node[1], env)
    if op == "cmp":
        _, cmp_op, left, right = node
        l = _eval_node(left, env)
        r = _eval_node(right, env)
        # Normalize boolean-equivalent operands for == / !=, so
        # `imaging_lung_lesion == 'yes'` and `imaging_lung_lesion == true`
        # both succeed regardless of which form the agent emitted.
        # Order comparators (>, <, etc.) are left untouched — they don't
        # apply to boolean strings.
        if cmp_op in ("==", "!="):
            l = _canonical_bool(l)
            r = _canonical_bool(r)
        if cmp_op == "==": return l == r
        if cmp_op == "!=": return l != r
        if cmp_op == ">": return l > r
        if cmp_op == ">=": return l >= r
        if cmp_op == "<": return l < r
        if cmp_op == "<=": return l <= r
    if op == "in":
        l = _eval_node(node[1], env)
        r = _eval_node(node[2], env)
        # Normalize both sides so `imaging_lung_lesion in ['yes','true']`
        # matches an agent who wrote a boolean True.
        l = _canonical_bool(l)
        r = [_canonical_bool(x) for x in (r or [])]
        return l in r
    if op == "if":
        cond = _eval_node(node[1], env)
        return _eval_node(node[2], env) if cond else _eval_node(node[3], env)
    if op == "arith":
        _, arith_op, left, right = node
        l = _eval_node(left, env)
        r = _eval_node(right, env)
        if l is None or r is None:
            return None
        # Restrict to numeric operands; bool is a subclass of int in Python
        # but doesn't make sense in arithmetic, so reject it explicitly.
        # Matches the TS evaluator, which yields NaN→null for non-numeric
        # operands.
        if isinstance(l, bool) or isinstance(r, bool):
            return None
        if not isinstance(l, (int, float)) or not isinstance(r, (int, float)):
            return None
        try:
            if arith_op == "+": return l + r
            if arith_op == "-": return l - r
            if arith_op == "*": return l * r
            if arith_op == "/":
                if r == 0:
                    return None
                return l / r
        except (TypeError, ZeroDivisionError):
            return None
    if op == "neg":
        v = _eval_node(node[1], env)
        if v is None:
            return None
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return None
        return -v
    if op == "call":
        _, name, arg_nodes = node
        if name not in _BUILTINS:
            raise NameError(f"Unknown builtin: {name}")
        args = [_eval_node(a, env) for a in arg_nodes]
        return _BUILTINS[name](args)
    raise ValueError(f"Unknown node op: {op}")


def evaluate(expr: str, env: dict[str, Any]) -> Any:
    """Evaluate a derivation expression. Multi-line expressions are flattened."""
    flat = " ".join(line.strip() for line in expr.splitlines())
    tokens = _tokenize(flat)
    tree = _Parser(tokens).parse()
    return _eval_node(tree, env)


def derived_field_inputs(derivation: str, all_field_ids: list[str]) -> list[str]:
    return [fid for fid in all_field_ids if re.search(rf"\b{re.escape(fid)}\b", derivation)]


NOT_APPLICABLE = "not_applicable"


def _eval_gate(expr: str, env: dict[str, Any]) -> str:
    """Evaluate an `is_applicable_when` expression. Returns 'applicable',
    'not_applicable', or 'unknown' (when a referenced input is missing or the
    expression raises)."""
    try:
        result = evaluate(expr, env)
    except NameError:
        return "unknown"
    except Exception:
        return "unknown"
    return "applicable" if result else "not_applicable"


def compute_applicability(
    compiled_task: dict[str, Any],
    values: dict[str, Any],
) -> dict[str, str]:
    """Per-field applicability map.

    Fields without `is_applicable_when` are always 'applicable'. Fields whose
    gate evaluates to false are 'not_applicable'. If the gate references an
    input not yet in `values`, the field is 'unknown' and consumers should
    treat it as pending (not gated).
    """
    out: dict[str, str] = {}
    for f in compiled_task["fields"]:
        gate = f.get("is_applicable_when")
        if not gate:
            out[f["id"]] = "applicable"
        else:
            out[f["id"]] = _eval_gate(gate, values)
    return out


def evaluate_all(compiled_task: dict[str, Any], leaf_values: dict[str, Any]) -> dict[str, Any]:
    fields = compiled_task["fields"]
    derived = [f for f in fields if "derivation" in f]
    values = dict(leaf_values)
    # Apply applicability to leaves first — gated leaves resolve to NOT_APPLICABLE
    # in the derivation env, so downstream derived fields propagate the gate.
    leaf_applicability = compute_applicability(
        compiled_task,
        {f["id"]: values.get(f["id"]) for f in fields if "derivation" not in f},
    )
    for f in fields:
        if "derivation" in f:
            continue
        if leaf_applicability.get(f["id"]) == "not_applicable":
            values[f["id"]] = NOT_APPLICABLE

    max_iter = len(derived) + 1
    for _ in range(max_iter):
        progressed = False
        for f in derived:
            fid = f["id"]
            if fid in values:
                continue
            inputs = derived_field_inputs(f["derivation"], [x["id"] for x in fields])
            if not all(i in values for i in inputs):
                continue
            # If this derived field is gated and the gate evaluates to false,
            # short-circuit to NOT_APPLICABLE without running the derivation.
            gate = f.get("is_applicable_when")
            if gate:
                gate_status = _eval_gate(gate, values)
                if gate_status == "not_applicable":
                    values[fid] = NOT_APPLICABLE
                    progressed = True
                    continue
            try:
                values[fid] = evaluate(f["derivation"], values)
                progressed = True
            except Exception:
                values[fid] = None
        if not progressed:
            break
    return {f["id"]: values.get(f["id"]) for f in derived}
