#!/usr/bin/env python3
"""Stdlib-only validator for the JSON Schema subset catalog.schema.json uses.

Supported keywords: type, const, enum, required, properties,
additionalProperties (bool), items, minItems/maxItems, uniqueItems,
minLength/maxLength (UTF-16 units, as the C# side counts), pattern,
minimum, $ref to #/$defs/... — anything else in a schema is an error, so
the schema cannot silently grow past what this checks.

    python mod-contract/tools/schema_check.py path/to/catalog.json
"""

import json
import pathlib
import re
import sys

SCHEMA_PATH = pathlib.Path(__file__).resolve().parent.parent / "catalog.schema.json"

_ANNOTATIONS = {"$schema", "$id", "title", "description", "$defs"}
_KNOWN = _ANNOTATIONS | {
    "type", "const", "enum", "required", "properties", "additionalProperties", "items",
    "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "minimum", "$ref",
}

_TYPES = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def _utf16_len(s: str) -> int:
    return len(s.encode("utf-16-le", errors="surrogatepass")) // 2


def validate(value, schema: dict, root: dict | None = None, path: str = "$") -> list[str]:
    """Returns a list of '<json path>: <problem>' strings (empty = valid)."""
    root = root or schema
    unknown = set(schema) - _KNOWN
    if unknown:
        raise ValueError(f"{path}: unsupported schema keyword(s) {sorted(unknown)}")
    if "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/$defs/"):
            raise ValueError(f"{path}: unsupported $ref {ref}")
        return validate(value, root["$defs"][ref[len("#/$defs/"):]], root, path)

    errors = []
    if "type" in schema:
        types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_TYPES[t](value) for t in types):
            return [f"{path}: expected {'/'.join(types)}, got {type(value).__name__}"]
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: must be {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: must be one of {schema['enum']}")
    if isinstance(value, str):
        n = _utf16_len(value)
        if n < schema.get("minLength", 0):
            errors.append(f"{path}: shorter than {schema['minLength']}")
        if "maxLength" in schema and n > schema["maxLength"]:
            errors.append(f"{path}: longer than {schema['maxLength']}")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{path}: does not match {schema['pattern']}")
    if _TYPES["number"](value) and "minimum" in schema and value < schema["minimum"]:
        errors.append(f"{path}: below {schema['minimum']}")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{path}: fewer than {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{path}: more than {schema['maxItems']} items")
        if schema.get("uniqueItems") and len({json.dumps(v, sort_keys=True) for v in value}) != len(value):
            errors.append(f"{path}: items are not unique")
        if "items" in schema:
            for i, item in enumerate(value):
                errors += validate(item, schema["items"], root, f"{path}[{i}]")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: missing required '{key}'")
        props = schema.get("properties", {})
        for key, item in value.items():
            if key in props:
                errors += validate(item, props[key], root, f"{path}.{key}")
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}: unexpected property '{key}'")
    return errors


def validate_catalog(catalog) -> list[str]:
    return validate(catalog, json.loads(SCHEMA_PATH.read_text(encoding="utf-8")))


def main(argv=None) -> int:
    paths = argv if argv is not None else sys.argv[1:]
    bad = 0
    for p in paths:
        errors = validate_catalog(json.loads(pathlib.Path(p).read_text(encoding="utf-8")))
        for e in errors:
            print(f"{p}: {e}")
        bad += bool(errors)
        if not errors:
            print(f"{p}: valid")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
