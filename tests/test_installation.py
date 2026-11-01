import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

from scripts.build_package import ROOT, build
from start import save_key


class InstallationTests(unittest.TestCase):
    def test_key_update_preserves_settings_and_rejects_injection(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / ".env"
            path.write_text("# Keep me\nOTHER_SETTING=original\nexport OPENAI_API_KEY = 'sk-...'\n")
            save_key(path, "test-only-key")
            self.assertEqual(path.read_text(), "# Keep me\nOTHER_SETTING=original\nOPENAI_API_KEY='test-only-key'\n")
            if os.name != "nt":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            before = path.read_bytes()
            for key in ["", "sk-...", "your-key-here", "x\nINJECT=1", "x'bad"]:
                with self.assertRaises(ValueError):
                    save_key(path, key)
                self.assertEqual(path.read_bytes(), before)

    def test_archives_are_complete_and_exclude_private_files(self):
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder)
            packages = build(ROOT, destination)
            for package in packages:
                with zipfile.ZipFile(package) as archive:
                    names = archive.namelist()
                    self.assertFalse(any(Path(name).name == ".env" for name in names))
                    self.assertFalse(any(part in {".git", ".venv", "artifacts", "node_modules", ".pawse-runtime", "tests"}
                                         for name in names for part in Path(name).parts))
                    manifest_name = next(n for n in names if n.endswith("/manifest.json"))
                    prefix = manifest_name.removesuffix("manifest.json")
                    manifest = json.loads(archive.read(manifest_name))
                    assets = [f for script in manifest["content_scripts"] for f in script["js"]]
                    assets += [f for resource in manifest["web_accessible_resources"] for f in resource["resources"]]
                    self.assertTrue(all(prefix + name in names for name in assets))
            with zipfile.ZipFile(destination / "pawse-hackathon.zip") as archive:
                archive.extractall(destination / "extracted")
            kit = destination / "extracted/Pawse"
            result = subprocess.run([sys.executable, "-c", "from backend.app import app; assert app.title.startswith('Pawse')"],
                                    cwd=kit, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((kit / "Start Pawse.bat").is_file())
            self.assertTrue((kit / "Start Pawse.command").is_file())


if __name__ == "__main__":
    unittest.main()
