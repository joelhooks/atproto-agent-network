import json
import os
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATHS = {
    "rpg": REPO_ROOT / "sandboxes/scripts/rpg/take_turn.py",
    "catan": REPO_ROOT / "sandboxes/scripts/catan/take_turn.py",
    "coding": REPO_ROOT / "sandboxes/scripts/coding/take_turn.py",
}


class _OpenRouterStubHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        self.server.requests.append(  # type: ignore[attr-defined]
            {"headers": dict(self.headers.items()), "body": json.loads(body)}
        )
        response_body = json.dumps(
            {
                "choices": [
                    {
                        "message": {
                            "content": "```json\n{\"action\":\"explore\",\"target\":\"ruins\"}\n```"
                        }
                    }
                ]
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response_body)))
        self.end_headers()
        self.wfile.write(response_body)

    def log_message(self, _fmt, *_args):
        return


class TurnProcessorTests(unittest.TestCase):
    def _start_stub_server(self):
        server = HTTPServer(("127.0.0.1", 0), _OpenRouterStubHandler)
        server.requests = []  # type: ignore[attr-defined]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, thread

    def test_turn_scripts_call_openrouter_and_emit_action_json(self):
        server, thread = self._start_stub_server()
        base_url = f"http://127.0.0.1:{server.server_port}/api/v1/chat/completions"

        with tempfile.TemporaryDirectory() as temp_dir:
            for env_type in SCRIPT_PATHS:
                Path(temp_dir, f"{env_type}-player.md").write_text(
                    f"{env_type} skill prompt", encoding="utf-8"
                )

            for env_type, script_path in SCRIPT_PATHS.items():
                with self.subTest(env_type=env_type):
                    process = subprocess.run(
                        ["python3", str(script_path)],
                        input=json.dumps({"env_type": env_type, "game_state": {"turn": 1}}),
                        text=True,
                        capture_output=True,
                        env={
                            **os.environ,
                            "OPENROUTER_API_KEY": "test-key",
                            "OPENROUTER_API_URL": base_url,
                            "SANDBOX_SKILLS_DIR": temp_dir,
                        },
                        check=False,
                    )
                    self.assertEqual(0, process.returncode, process.stderr)
                    self.assertEqual(
                        {"action": "explore", "target": "ruins"},
                        json.loads(process.stdout),
                    )

        server.shutdown()
        thread.join(timeout=2)
        server.server_close()

        self.assertEqual(3, len(server.requests))  # type: ignore[attr-defined]
        for request in server.requests:  # type: ignore[attr-defined]
            self.assertEqual("Bearer test-key", request["headers"]["Authorization"])
            messages = request["body"]["messages"]
            self.assertIn("skill prompt", messages[0]["content"])

    def test_turn_script_requires_openrouter_api_key(self):
        script_path = SCRIPT_PATHS["rpg"]
        process = subprocess.run(
            ["python3", str(script_path)],
            input=json.dumps({"env_type": "rpg", "game_state": {}}),
            text=True,
            capture_output=True,
            env={**os.environ},
            check=False,
        )
        self.assertNotEqual(0, process.returncode)
        self.assertIn("OPENROUTER_API_KEY", process.stderr)


if __name__ == "__main__":
    unittest.main()
