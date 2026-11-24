from pathlib import Path, PurePosixPath
import hashlib, json, stat, zipfile

manifest = json.loads(Path("manifest.json").read_text("utf-8"))
archive = Path(manifest["asset"])
assert archive.stat().st_size == manifest["bytes"], "Release asset size mismatch"
assert hashlib.sha256(archive.read_bytes()).hexdigest() == manifest["sha256"], "Release asset SHA-256 mismatch"
target = Path("_site").resolve()
target.mkdir(exist_ok=True)
with zipfile.ZipFile(archive) as z:
    entries = [i for i in z.infolist() if not i.is_dir()]
    assert len(entries) == manifest["files"], "Release file count mismatch"
    for entry in entries:
        name = PurePosixPath(entry.filename)
        assert not name.is_absolute() and ".." not in name.parts and "\\" not in entry.filename
        assert not stat.S_ISLNK(entry.external_attr >> 16), "Symlink is not allowed"
        destination = target.joinpath(*name.parts).resolve()
        assert destination.is_relative_to(target)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(z.read(entry))
assert (target / "index.html").is_file()
assert not list(target.rglob("*.pdf"))
assert not (target / "精品题库/运行资源/Word原版格式.js").exists()
print(f"Verified {len(entries)} runtime files; deployment ready.")
