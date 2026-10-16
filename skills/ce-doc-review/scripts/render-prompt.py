#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import re
import sys

parser = argparse.ArgumentParser(description="Render a reviewer prompt from the original template.")
parser.add_argument("slots", type=Path, help="UTF-8 JSON object of named string slots")
args = parser.parse_args()

try:
    slots = json.loads(args.slots.read_text(encoding="utf-8"))
except (OSError, ValueError) as error:
    parser.error(str(error))
if not isinstance(slots, dict):
    parser.error("slots must be a JSON object")

template = (Path(__file__).resolve().parent.parent / "references/subagent-template.md").read_text(encoding="utf-8")
template = template.split("\n```\n", 1)[1].rsplit("\n```", 1)[0]
pattern = r"\{([a-z_]+)\}"
for name in sorted(set(re.findall(pattern, template))):
    if not isinstance(slots.get(name), str):
        parser.error(f"{name} must be supplied as a string")

sys.stdout.buffer.write((re.sub(pattern, lambda match: slots[match[1]], template) + "\n").encode("utf-8"))
