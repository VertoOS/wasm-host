import os
import unittest

from wasm_host import Mount, RunOptions, load_library, run


@unittest.skipUnless(os.environ.get("WASM_HOST_LIBRARY"), "WASM_HOST_LIBRARY is not set")
class PythonBindingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.library = load_library()

    def test_version_comes_from_c_abi(self):
        self.assertRegex(self.library.version(), r"^\d+\.\d+\.\d+")

    def test_empty_command_returns_error_result(self):
        result = run(RunOptions(webc="missing.webc", command=[]), self.library)

        self.assertFalse(result.ok)
        self.assertEqual(result.returncode, 125)
        self.assertEqual(result.error_text, "command cannot be empty")
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"")

    def test_options_encode_stdin_and_read_only_mount_default(self):
        options = RunOptions(
            webc="missing.webc",
            command=["tool"],
            stdin=b"hello",
            mounts=[Mount(source=".", target="/workspace")],
            module_cache_dir="/tmp/wasm-host-modules",
            http_bridge="native",
        )

        encoded = options.to_json()
        self.assertIn('"stdin_base64":"aGVsbG8="', encoded)
        self.assertIn('"read_only":true', encoded)
        self.assertIn('"module_cache_dir":"/tmp/wasm-host-modules"', encoded)
        self.assertIn('"http_bridge":"native"', encoded)

    def test_unknown_http_bridge_returns_error_result(self):
        result = self.library.run_json(
            '{"webc":"missing.webc","command":["tool"],"http_bridge":"bad"}'
        )

        self.assertFalse(result.ok)
        self.assertEqual(result.returncode, 125)
        self.assertEqual(
            result.error_text, "unknown HTTP bridge mode: bad; expected off or native"
        )


if __name__ == "__main__":
    unittest.main()
