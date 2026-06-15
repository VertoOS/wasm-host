import json
import os
from pathlib import Path
import sys


tmp_path = Path("/tmp/wasm-host-python-e2e.txt")
tmp_path.write_text("python wrote this\n", encoding="utf-8")

print(
    json.dumps(
        {
            "marker": "PYTHON_E2E_OK",
            "argv": sys.argv[1:],
            "cwd": os.getcwd(),
            "tmp": tmp_path.read_text(encoding="utf-8").strip(),
            "version": list(sys.version_info[:3]),
        },
        sort_keys=True,
    )
)
