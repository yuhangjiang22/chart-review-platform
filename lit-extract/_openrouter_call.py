#!/usr/bin/env python3
"""
OpenRouter API wrapper for lit-extract skill.

Usage:
    python3 _openrouter_call.py \
        --model "anthropic/claude-haiku-4-5" \
        --prompt-file /tmp/prompt.txt \
        --output-file /tmp/result.json \
        --api-key "sk-or-..."
"""

import argparse
import json
import sys
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--output-file", required=True)
    parser.add_argument("--api-key", required=True)
    args = parser.parse_args()

    with open(args.prompt_file, "r", encoding="utf-8") as f:
        prompt = f.read()

    payload = json.dumps({
        "model": args.model,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {args.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "lit-extract-skill",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code}: {error_body}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Request failed: {e.reason}", file=sys.stderr)
        sys.exit(1)
    except TimeoutError:
        print("Request timed out after 120s", file=sys.stderr)
        sys.exit(1)

    try:
        data = json.loads(body)
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, json.JSONDecodeError) as e:
        print(f"Failed to parse response: {e}\nBody: {body}", file=sys.stderr)
        sys.exit(1)

    with open(args.output_file, "w", encoding="utf-8") as f:
        f.write(content)


if __name__ == "__main__":
    main()
