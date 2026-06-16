import os
import unittest

from wasm_host import ABI_VERSION, HostCommand, Mount, RunOptions, load_library, run


@unittest.skipUnless(os.environ.get("WASM_HOST_LIBRARY"), "WASM_HOST_LIBRARY is not set")
class PythonBindingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.library = load_library()

    def test_version_comes_from_c_abi(self):
        self.assertRegex(self.library.version(), r"^\d+\.\d+\.\d+")

    def test_abi_version_comes_from_c_abi(self):
        self.assertEqual(ABI_VERSION, 1)
        self.assertEqual(self.library.abi_version(), ABI_VERSION)

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
            host_commands=[
                HostCommand(guest_path="/tools/echo", host_command="/bin/echo")
            ],
            module_cache_dir="/tmp/wasm-host-modules",
            http_bridge="native",
        )

        encoded = options.to_json()
        self.assertIn('"stdin_base64":"aGVsbG8="', encoded)
        self.assertIn('"read_only":true', encoded)
        self.assertIn(
            '"host_commands":[{"guest_path":"/tools/echo","host_command":"/bin/echo"}]',
            encoded,
        )
        self.assertIn('"module_cache_dir":"/tmp/wasm-host-modules"', encoded)
        self.assertIn('"http_bridge":"native"', encoded)

    def test_unknown_http_bridge_returns_error_result(self):
        result = self.library.run_json(
            '{"webc":"missing.webc","command":["tool"],"http_bridge":"bad"}'
        )

        self.assertFalse(result.ok)
        self.assertEqual(result.returncode, 125)
        self.assertEqual(
            result.error_text,
            "unknown HTTP bridge mode: bad; expected off, native, or gateway=<url>",
        )

    def test_host_command_without_native_full_returns_error_result(self):
        result = run(
            RunOptions(
                webc="missing.webc",
                command=["tool"],
                host_commands=[
                    HostCommand(guest_path="/tools/echo", host_command="/bin/echo")
                ],
            ),
            self.library,
        )

        self.assertFalse(result.ok)
        self.assertEqual(result.returncode, 125)
        self.assertEqual(
            result.error_text,
            "host_commands require the native-full profile, current profile is browser-strict",
        )

    def test_runs_generated_fixture_package(self):
        fixture = os.environ.get("WASM_HOST_BINDING_FIXTURE_WEBC")
        if fixture is None:
            self.skipTest("WASM_HOST_BINDING_FIXTURE_WEBC is not set")

        result = run(
            RunOptions(
                webc=fixture,
                command=["stdout-fixture"],
            ),
            self.library,
        )

        self.assertTrue(result.ok, result.error_text)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"BINDING_FIXTURE_OK\n")
        self.assertEqual(result.stderr, b"")


if __name__ == "__main__":
    unittest.main()
