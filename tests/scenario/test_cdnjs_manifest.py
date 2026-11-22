"""scripts/cdnjs-manifest.py (V2-37): each cdnjs answer is capped and each kept hash is a well-formed sha512. The
network is a stand-in; nothing is fetched."""
import base64
import hashlib
import importlib.util
import io
import os
import unittest
from unittest import mock

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "cdnjs-manifest.py")
spec = importlib.util.spec_from_file_location("cdnjs_manifest", PATH)
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)

GOOD = "sha512-" + base64.b64encode(hashlib.sha512(b"x").digest()).decode()


class Answer(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


class ManifestTool(unittest.TestCase):
    def test_manifest_tool_rejects_oversize_and_bad_base64(self):
        # A well-formed answer reads; one past the cap stops the tool instead of being kept or truncated.
        with mock.patch.object(tool.urllib.request, "urlopen", return_value=Answer(b'{"sri": {}}')):
            self.assertEqual(tool.get("https://api.cdnjs.com/x"), {"sri": {}})
        big = b'{"sri": "' + b"a" * tool.RESPONSE_CAP + b'"}'
        with mock.patch.object(tool.urllib.request, "urlopen", return_value=Answer(big)):
            with self.assertRaises(SystemExit):
                tool.get("https://api.cdnjs.com/x")
        # Only a strict base64 of 64 bytes after `sha512-` is kept.
        self.assertTrue(tool.sri_ok(GOOD))
        for bad in [
            GOOD[:-4],  # 61 bytes
            GOOD.replace("sha512-", "sha384-"),
            GOOD[:-2] + "!=",  # not base64
            GOOD + " ",  # trailing junk
            "sha512-" + base64.b64encode(b"x" * 63).decode(),
            "sha512-",
            None,
            42,
        ]:
            self.assertFalse(tool.sri_ok(bad), bad)


if __name__ == "__main__":
    unittest.main()
