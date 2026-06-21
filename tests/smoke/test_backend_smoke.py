from __future__ import annotations

import os
import unittest
import urllib.error
import urllib.request


class BackendSmokeTests(unittest.TestCase):
    def test_configured_backend_url_responds_without_server_error(self) -> None:
        url = os.environ.get("CONJURE_SMOKE_BACKEND_URL", "").strip()
        if not url:
            self.skipTest("set CONJURE_SMOKE_BACKEND_URL to run the live backend smoke test")

        request = urllib.request.Request(url, headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                status = response.status
        except urllib.error.HTTPError as exc:
            status = exc.code

        self.assertLess(status, 500)


if __name__ == "__main__":
    unittest.main()
