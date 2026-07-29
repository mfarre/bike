#!/usr/bin/env python3
"""Build tracks.json from GPX files and their Git history."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--tracks-dir",
        type=Path,
        default=Path("tracks"),
        help="Directory containing GPX files (default: tracks)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("tracks.json"),
        help="Output JSON path (default: tracks.json)",
    )
    return parser.parse_args()


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def first_text(root: ET.Element, parent_name: str | None, child_name: str) -> str | None:
    """Return text from the first matching direct child, optionally below a parent."""
    parents = [root] if parent_name is None else [node for node in root.iter() if local_name(node.tag) == parent_name]
    for parent in parents:
        for child in list(parent):
            if local_name(child.tag) == child_name and child.text and child.text.strip():
                return child.text.strip()
    return None


def read_gpx_title(path: Path) -> str:
    """Prefer metadata/name, then track/route name, then a readable filename."""
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError) as exc:
        print(f"warning: could not parse title from {path}: {exc}", file=sys.stderr)
        return readable_stem(path)

    title = (
        first_text(root, "metadata", "name")
        or first_text(root, "trk", "name")
        or first_text(root, "rte", "name")
        or first_text(root, None, "name")
    )
    return title or readable_stem(path)


def readable_stem(path: Path) -> str:
    return path.stem.replace("_", " ").replace("-", " ").strip() or path.name


def first_git_date(path: Path) -> str:
    """Return the earliest commit date reachable while following this path."""
    command = [
        "git",
        "log",
        "--follow",
        "--format=%cI",
        "--",
        path.as_posix(),
    ]

    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        result = None

    if result and result.returncode == 0:
        dates = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        if dates:
            return dates[-1]

    # Useful for local previews before the file has been committed.
    modified = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    return modified.isoformat(timespec="seconds")


def build_manifest(tracks_dir: Path) -> dict[str, object]:
    if not tracks_dir.exists():
        raise FileNotFoundError(f"Tracks directory does not exist: {tracks_dir}")
    if not tracks_dir.is_dir():
        raise NotADirectoryError(f"Tracks path is not a directory: {tracks_dir}")

    gpx_files = sorted(
        path for path in tracks_dir.rglob("*")
        if path.is_file() and path.suffix.lower() == ".gpx"
    )

    tracks: list[dict[str, str]] = []
    for path in gpx_files:
        tracks.append(
            {
                "file": path.as_posix(),
                "title": read_gpx_title(path),
                "addedAt": first_git_date(path),
            }
        )

    def sort_key(item: dict[str, str]) -> tuple[float, str]:
        try:
            timestamp = datetime.fromisoformat(item["addedAt"]).timestamp()
        except ValueError:
            timestamp = 0.0
        return (-timestamp, item["title"].casefold())

    tracks.sort(key=sort_key)

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tracks": tracks,
    }


def main() -> int:
    args = parse_args()

    try:
        manifest = build_manifest(args.tracks_dir)
    except (FileNotFoundError, NotADirectoryError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(manifest['tracks'])} tracks to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
