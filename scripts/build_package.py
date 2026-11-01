"""Build judge ZIPs from an explicit runtime allowlist; never archive the checkout."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def extension_files(root: Path) -> list[str]:
    manifest = json.loads((root / "manifest.json").read_text())
    files = {"manifest.json", "popup.js", "popup.css", "sites.js"}
    files.update(manifest.get("icons", {}).values())
    files.add(manifest["background"]["service_worker"])
    files.add(manifest["action"]["default_popup"])
    files.update(manifest["action"].get("default_icon", {}).values())
    for script in manifest["content_scripts"]:
        files.update(script.get("js", []))
        files.update(script.get("css", []))
    for resources in manifest["web_accessible_resources"]:
        files.update(resources["resources"])
    for name in files:
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or any(p.startswith(".") for p in path.parts) or "*" in name:
            raise ValueError(f"Unsafe extension asset path: {name}")
        if not (root / name).is_file():
            raise ValueError(f"Missing extension asset: {name}")
    return sorted(files)


def build(root: Path, output: Path) -> list[Path]:
    output.mkdir(parents=True, exist_ok=True)
    extension = extension_files(root)
    runtime = ["start.py", "start.sh", "Start Pawse.command", "Start Pawse.bat",
               "requirements-runtime.txt", ".env.example", "INSTALL.md", "backend/__init__.py",
               "backend/app.py", "experiments/youtube_frames.py"]
    packages = {
        "pawse-extension.zip": [(name, f"Pawse-extension/{name}") for name in extension],
        "pawse-hackathon.zip": [(name, f"Pawse/extension/{name}") for name in extension]
            + [(name, f"Pawse/{name}") for name in runtime],
    }
    result = []
    for name, entries in packages.items():
        target = output / name
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for source, destination in sorted(entries):
                info = zipfile.ZipInfo(destination, date_time=(2026, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (0o100755 if source.endswith((".command", ".sh")) else 0o100644) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, (root / source).read_bytes())
        result.append(target)
    (output / "SHA256SUMS.txt").write_text("".join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in result))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    for path in build(ROOT, args.output):
        print(path)
