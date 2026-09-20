# -*- coding: utf-8 -*-
"""Copy the Chrome load root into extension/ and optionally zip it.

Zip root contains manifest.json (unzip then Load unpacked — no nested junk).
"""
from __future__ import annotations

import argparse
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "extension"

RUNTIME_SUFFIXES = {'.js', '.mjs', '.json', '.css', '.html', '.wasm', '.png', '.jpg',
                    '.jpeg', '.svg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf'}
SKIP_PARTS = {'node_modules', '__pycache__', '__MACOSX', 'secrets'}


def runtime_files(root: Path = ROOT) -> list[str]:
    """Package runtime roots from the working tree, including uncommitted modules.

    No .git is required. Never recurse into build output or collect credentials,
    hidden files, docs, arbitrary extensions, or symlinks from a user's machine.
    """
    files = ['manifest.json', 'LICENSE']
    for name in ('src', 'icons'):
        for path in sorted((root / name).rglob('*')):
            rel = path.relative_to(root)
            if any(part.startswith('.') or part in SKIP_PARTS for part in rel.parts):
                continue
            if path.is_symlink():
                raise ValueError(f'Runtime symlinks are not supported: {rel}')
            if not path.is_file() or path.suffix.lower() not in RUNTIME_SUFFIXES:
                continue
            if path.name.lower() in {'credentials.json', 'secrets.json'}:
                continue
            files.append(rel.as_posix())
    return sorted(files)


def copy_tree() -> list[str]:
    if DEST.exists():
        shutil.rmtree(DEST)
    DEST.mkdir(parents=True)
    copied: list[str] = []
    for rel in runtime_files():
        src = ROOT / rel
        if not src.is_file():
            raise ValueError(f'Missing required runtime file: {rel}')
        dst = DEST / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        copied.append(rel.replace("\\", "/"))
    return copied


def write_readme() -> None:
    (DEST / "README.md").write_text(
        """# Browser Kitten

Chrome MV3 **unpacked** load root. Not on the Chrome Web Store.

1. Chrome → `chrome://extensions` → Developer mode
2. **Load unpacked** → select **this folder** (it contains `manifest.json`)
3. Open the side panel → paste your API key → send a task on a normal webpage

Need Chrome 135+. Chrome 138+: allow **User Scripts** on the extension card for `sys.eval` / page fetch. Close F12 on the target tab before CDP.

After you change files here, click **重新加载** on the extension card. Restricted pages (`chrome://`, Web Store) return `NEED_PAGE`. You must bring your own model key.
""",
        encoding="utf-8",
    )


def write_zip(zip_path: Path) -> None:
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(DEST.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(DEST).as_posix())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", type=Path, help="Write a zip whose root is manifest.json")
    args = parser.parse_args()
    copied = copy_tree()
    write_readme()
    from verify_extension import verify
    print('integrity:', verify(DEST, ROOT))
    print(f"extension/ files: {len(copied) + 1}")
    print("top-level:", ", ".join(sorted(p.name for p in DEST.iterdir())))
    if args.zip:
        write_zip(args.zip.resolve())
        print("zip", args.zip.resolve(), args.zip.resolve().stat().st_size)


if __name__ == "__main__":
    main()
