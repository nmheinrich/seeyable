#!/usr/bin/env python3
"""Create a source-only judging download using an explicit runtime allowlist."""
import fnmatch
import hashlib
import json
from pathlib import Path
import re
import shlex
import zipfile

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "apps/extension"
manifest = json.loads((EXT / "manifest.json").read_text())
assert manifest["manifest_version"] == 3
assert "debugger" not in manifest.get("permissions", [])
files = ["manifest.json", "background.js", "content.js", "sidepanel.html",
         "sidepanel.css", "sidepanel.js", "mic-setup.html", "mic-setup.js"]
files += [f"lib/{name}.js" for name in (
    "bridge-client", "command-resolver", "executor", "meta-voice", "overlay",
    "plan-schema", "planner", "snapshot-cdp", "snapshot-dom", "voice-commands")]
files += [f"fonts/{name}" for name in (
    "DMMono-400.woff2", "DMMono-500.woff2", "Jost-400.woff2", "Jost-500.woff2",
    "Jost-600.woff2", "OFL-DMMono.txt", "OFL-Jost.txt")]
files += [f"icons/icon-{size}.png" for size in (16, 32, 48, 128)]
included = set(files)
refs = [manifest["background"]["service_worker"], manifest["side_panel"]["default_path"]]
for entry in manifest["content_scripts"]:
    refs.extend(entry.get("js", []) + entry.get("css", []))
for name in files:
    if name.endswith((".html", ".css")):
        source = (EXT / name).read_text()
        for ref in re.findall(r'(?:src|href)=["\']([^"\']+)|url\(["\']?([^\)"\']+)', source):
            value = next(v for v in ref if v)
            if not value.startswith(("http:", "https:", "data:", "#")):
                refs.append((Path(name).parent / value).as_posix())
assert all(ref in included for ref in refs), "Runtime asset missing from allowlist"

prefix = f"seeyable-judging-{manifest['version']}"
payload = {f"extension/{name}": (EXT / name).read_bytes() for name in files}
payload.update({
    "START-HERE.md": (ROOT / "docs/judge-quickstart.md").read_bytes(),
    "LICENSE": (ROOT / "LICENSE").read_bytes(),
    "setup-mcp.sh": (ROOT / "scripts/setup-mcp.sh").read_bytes(),
    "docker/setup-mcp.mjs": (ROOT / "docker/setup-mcp.mjs").read_bytes(),
    "demo-survey/index.html": (ROOT / "apps/demo-survey/index.html").read_bytes(),
    # Preserve the repository path consumed by docker/Dockerfile as well as
    # the shorter path used by the key-free Python quickstart.
    "apps/demo-survey/index.html": (ROOT / "apps/demo-survey/index.html").read_bytes(),
})
for name in ["compose.yaml", ".dockerignore", "docker/Dockerfile", "docker/start.mjs",
             "docker/.env.example", "apps/mcp-server/package.json",
             "apps/mcp-server/package-lock.json", "apps/mcp-server/server.mjs",
             "apps/mcp-server/bridge-daemon.mjs", "apps/planner-proxy/server.mjs",
             "packages/shared/package.json", "packages/shared/plan-schema.js"]:
    payload[name] = (ROOT / name).read_bytes()
for directory in ["apps/mcp-server/lib", "apps/planner-proxy/lib"]:
    for source in sorted((ROOT / directory).glob("*.mjs")):
        payload[source.relative_to(ROOT).as_posix()] = source.read_bytes()
payload["DOCKER-SETUP.md"] = (ROOT / "docs/docker-quickstart.md").read_bytes()
payload["MCP-SETUP.md"] = (ROOT / "docs/local-mcp-setup.md").read_bytes()
# Catch release layouts that work for Chrome but cannot be Docker build contexts.
for line in payload["docker/Dockerfile"].decode().splitlines():
    if line.startswith("COPY "):
        for source in shlex.split(line)[1:-1]:
            assert any(fnmatch.fnmatch(name, source) or name.startswith(source.rstrip("/") + "/")
                       for name in payload), f"Docker COPY source missing from archive: {source}"
out = ROOT / "dist" / f"{prefix}.zip"
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
    for name, data in sorted(payload.items()):
        info = zipfile.ZipInfo(f"{prefix}/{name}")
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, data)
with zipfile.ZipFile(out) as archive:
    assert archive.testzip() is None
    assert len(archive.namelist()) == len(payload)
    for name, data in payload.items():
        assert archive.read(f"{prefix}/{name}") == data
        assert (archive.getinfo(f"{prefix}/{name}").external_attr >> 16) & 0o777 == 0o644
digest = hashlib.sha256(out.read_bytes()).hexdigest()
out.with_suffix(".zip.sha256").write_text(f"{digest}  {out.name}\n")
print(f"Created {out} ({out.stat().st_size:,} bytes; {len(payload)} files)")
print("Verified ZIP integrity, byte-for-byte contents, and declared HTML/CSS/manifest assets.")
print(f"SHA256 {digest}")
