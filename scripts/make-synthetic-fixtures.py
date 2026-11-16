"""Derive clearly-labelled SYNTHETIC malformed fixtures from a live fixture.

Each output is a deliberately broken copy used only to test schema/validation
failure paths. They are NOT GLO data. Usage:
  python3 -I scripts/make-synthetic-fixtures.py fixtures/glo/v1
"""
import copy, json, os, sys

root = sys.argv[1]
src_path = os.path.join(root, "live/result-by-date/2024-03-01.json")
src = json.load(open(src_path, encoding="utf-8"))
out = os.path.join(root, "synthetic/malformed")

def data(d): return d["response"]["result"]["data"]

def write(name, doc, note):
    doc = copy.deepcopy(doc)
    if isinstance(doc, dict):
        doc["_synthetic"] = {"derived_from": "live/result-by-date/2024-03-01.json", "mutation": note}
    with open(os.path.join(out, name), "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2); f.write("\n")

d = copy.deepcopy(src); del data(d)["first"]
write("missing-first.json", d, "removed data.first")

d = copy.deepcopy(src); data(d)["second"]["number"][0]["value"] = "28657"
write("five-digit-number.json", d, "second[0].value truncated to 5 digits")

d = copy.deepcopy(src); data(d)["third"]["number"][0]["value"] = 56295
write("numeric-value.json", d, "third[0].value changed from string to JSON number (leading zero lost)")

d = copy.deepcopy(src); data(d)["fourth"]["number"].pop()
write("wrong-count-fourth.json", d, "fourth has 49 numbers instead of 50")

d = copy.deepcopy(src); n = data(d)["fifth"]["number"]; n[1]["value"] = n[0]["value"]
write("duplicate-in-fifth.json", d, "fifth[1].value duplicated from fifth[0]")

d = copy.deepcopy(src); data(d)["near1"]["number"][0]["value"] = "253600"
write("near1-not-adjacent.json", d, "near1[0] changed to a value not adjacent to first")

d = copy.deepcopy(src); data(d)["last2"]["price"] = "two thousand"
write("bad-price.json", d, "last2.price not a decimal string")

d = copy.deepcopy(src); d["status"] = False; d["statusMessage"] = "getLotteryResult - Error"
write("status-false.json", d, "envelope status=false")

with open(os.path.join(out, "truncated.json.txt"), "w", encoding="utf-8") as f:
    f.write(json.dumps(src, ensure_ascii=False)[:900])  # invalid JSON on purpose
