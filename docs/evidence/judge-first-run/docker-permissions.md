# Docker source-permission regression — 2026-11-04

Owner's clean-download Muse setup reached Docker startup but failed with
EACCES opening `/app/apps/demo-survey/index.html` after the root launcher
dropped to node. Reading the same file as root had succeeded. This was
an application-image permission defect, not a confirmed port conflict.

Reproduced in a separate Compose project with every extracted source file
0600 and directory 0700. Without normalization, normal startup exited 1
with the same EACCES path. The Dockerfile now runs `chmod -R a+rX /app`
after COPY; runtime secrets are excluded from the build context and mounted
separately. The packager explicitly records public ZIP files as 0644.
Launcher errors now include the filesystem/socket error code and path,
without printing configuration contents.

Verification after rebuilding with the fix:

- Container stayed running; UID 1000 read fixture, MCP server, shared schema.
- Internal fixture returned HTTP 200; planner rejected missing auth with 401
  and accepted its pairing token with 200 and keyConfigured false.
- Private state directory remained 0700; host runtime config stayed 0600.
- Setup helper generated Muse configuration; SDK client used that config
  to initialize Docker stdio MCP and list eight tools.
- Native relay authentication tests passed 2/2; diff checks passed.
- Test container/network stopped and removed; user's judging container and
  agent settings were not modified. No real Meta key/model call used here.

Published `seeyable-judging-0.1.0-mcp-setup-r2.zip`, 334,973 bytes, 57 files;
SHA-256 `b7181dd4b893f6166989ffc6d49dfa781088bb03d3434ed7e8dddbc28a9713c7`.
Anonymous download, checksum, ZIP integrity, all archive modes and the
packaged Dockerfile were verified. Release primary link points to r2.
Repository changes remain uncommitted. Owner's Muse browser test continues;
successful MCP tool discovery is not end-to-end Muse page acceptance.
