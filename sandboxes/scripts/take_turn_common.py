#!/usr/bin/env python3
import json
import os
import re
import sys
import urllib.error
import urllib.request
from typing import Any


DEFAULT_OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini"
DEFAULT_SKILLS_DIR = "/workspace/skills"


def _extract_json_object(raw: str) -> dict[str, Any]:
    text = raw.strip()

    fenced_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, flags=re.DOTALL)
    if fenced_match:
        text = fenced_match.group(1).strip()

    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        parsed = json.loads(text[start : end + 1])
        if isinstance(parsed, dict):
            return parsed

    raise ValueError("LLM response did not contain a JSON object action")


def _build_user_prompt(state: dict[str, Any]) -> str:
    return (
        "You are selecting the next action for an agent sandbox environment.\n"
        "Return ONLY a JSON object describing the action.\n\n"
        f"State:\n{json.dumps(state, ensure_ascii=True, sort_keys=True)}"
    )


def _call_openrouter(prompt_skill: str, state: dict[str, Any]) -> dict[str, Any]:
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is required")

    url = os.getenv("OPENROUTER_API_URL", DEFAULT_OPENROUTER_URL)
    model = os.getenv("OPENROUTER_MODEL", DEFAULT_OPENROUTER_MODEL)
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": prompt_skill},
            {"role": "user", "content": _build_user_prompt(state)},
        ],
    }
    request = urllib.request.Request(
        url=url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"OpenRouter request failed: {exc.code} {details}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"OpenRouter request failed: {exc.reason}") from exc

    data = json.loads(body)
    raw_message = data["choices"][0]["message"]["content"]
    return _extract_json_object(raw_message)


def run_from_stdin() -> None:
    state = json.load(sys.stdin)
    env_type = state.get("env_type")
    if not env_type:
        raise RuntimeError("Input JSON must include env_type")
    if not os.getenv("OPENROUTER_API_KEY"):
        raise RuntimeError("OPENROUTER_API_KEY is required")

    skills_dir = os.getenv("SANDBOX_SKILLS_DIR", DEFAULT_SKILLS_DIR)
    skill_path = os.path.join(skills_dir, f"{env_type}-player.md")
    with open(skill_path, "r", encoding="utf-8") as handle:
        skill_prompt = handle.read()

    action = _call_openrouter(skill_prompt, state)
    json.dump(action, sys.stdout)
    sys.stdout.write("\n")


def main() -> None:
    try:
        run_from_stdin()
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
