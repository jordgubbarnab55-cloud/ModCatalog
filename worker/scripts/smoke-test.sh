#!/usr/bin/env bash
# End-to-end smoke test for the upload path (owner runs it).
#
# Usage:
#   scripts/smoke-test.sh <worker-url> <token> <path-to-mod.zip> [catalog-url]
#
# 1. POSTs the zip to <worker-url>/upload and prints the HTTP status.
# 2. Polls the Pages catalog.json (no-store) until a mod with the uploaded
#    file's byte size appears that wasn't there before, or gives up after
#    5 minutes.

set -euo pipefail

WORKER="${1:?usage: smoke-test.sh <worker-url> <token> <zip> [catalog-url]}"
TOKEN="${2:?missing token}"
ZIP="${3:?missing zip path}"
CATALOG="${4:-https://jordgubbarnab55-cloud.github.io/ModCatalog/catalog.json}"

NAME="$(basename "$ZIP")"
SIZE="$(wc -c < "$ZIP" | tr -d ' ')"

echo "uploading $NAME ($SIZE bytes) to $WORKER/upload"
STATUS="$(curl -s -o /tmp/smoke-upload-resp.json -w '%{http_code}' \
  -X POST "$WORKER/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Filename: $NAME" \
  --data-binary @"$ZIP")"
echo "upload status: $STATUS"
cat /tmp/smoke-upload-resp.json 2>/dev/null; echo
if [ "$STATUS" != "202" ]; then
  echo "FAIL: expected 202, got $STATUS"
  exit 1
fi

echo "polling $CATALOG for up to 5 minutes ..."
python - "$CATALOG" "$SIZE" <<'EOF'
import json, sys, time, urllib.request

catalog_url, size = sys.argv[1], int(sys.argv[2])

def get():
    req = urllib.request.Request(catalog_url, headers={"Cache-Control": "no-store"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

deadline = time.time() + 300
try:
    known = {m["id"] for m in get()["mods"]}
except Exception as ex:
    print(f"note: could not read the catalog yet ({ex}); everything counts as new")
    known = set()

while time.time() < deadline:
    try:
        mods = get()["mods"]
    except Exception as ex:
        print(f"  catalog not readable yet ({ex}); retrying")
        time.sleep(10)
        continue
    for m in mods:
        if m.get("size") == size and m["id"] not in known:
            print(f"OK: new mod appeared: {m['name']} v{m['version']} ({m['size']} bytes)")
            print(f"    file: {m['file']}")
            sys.exit(0)
    print("  not in the catalog yet; retrying in 10 s")
    time.sleep(10)

print("FAIL: the mod did not appear in the catalog within 5 minutes")
print("      (check the 'Process inbox' workflow run log; see SETUP.md troubleshooting)")
sys.exit(1)
EOF
