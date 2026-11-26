# Handoff: GitHub source control and live collaboration for draw.io desktop

> **Status: in testing.** Not production ready. See [TESTING.md](TESTING.md).

Fork: https://github.com/rdemirian/drawio-desktop, branch `feature/github-source-control`.
Local copy: `~/drawio-desktop`. Run with `npm start`. Build the Mac app with
`npx electron-builder --config electron-builder-mac.json --mac --publish never` (output in `dist/`).

Feature docs: [source-control.md](source-control.md), [live-collaboration.md](live-collaboration.md).

## Done

### GitHub source control (tested end to end)
- Panel (⇧⌘G), status pill, File menu entries.
- Background fetch with notifications when teammates push. Preview of incoming changes as a visual diff.
- Commit, Commit & Sync, pull and push. Rejected pushes pull and retry.
- Cell-level three-way merge of diagrams (`renderer/diagram-merge.js`, built on draw.io's diffPages/patchPages) with a visual conflict dialog (mine/theirs per conflict). Git never merges `.drawio` textually (`merge=binary` in `.git/info/attributes`).
- Local edits are kept through pulls (backups in `.git/drawio-backups`). Merges can be aborted.
- History per diagram with "what changed", compare with now, restore.
- Branches: switch, track, create, open a pull request. Other branches touching the diagram are shown.
- Clone (with a picker of your GitHub repos), init, publish to GitHub (`gh`), add a remote, set identity.
- draw.io drafts and backups excluded via `.git/info/exclude`.

### Live collaboration (tested with 2 and 3 app instances on one Mac)
- WebRTC mesh with automatic host election by join order and instant host hand-off.
- Discovery over the LAN (UDP multicast) and the internet (hidden refs in the GitHub repo), both sealed with a key derived from the repository.
- Gossip: peers share who they are connected to and relay handshakes, so the mesh heals itself.
- Relayed peers: when two people can't connect directly, their traffic goes through a peer they share (`connectViaRelays`/`receiveForwarded`; test hook `live.blockDirect`).
- Edit sync: proposals have IDs and the host orders them. Overtaken edits are re-applied, checksums trigger resync, and unconfirmed edits are resent on host change.
- Cursors, selections, "doing" status, activity feed, flash of changed shapes in the author's colour, follow mode.
- Comments through draw.io's comments window, synced live, stored in `<diagram>.comments.jsonl` (union merge).
- Share dialog (GitHub link plus a `drawio-git://` link), Open GitHub Link, invites via `gh`.
- Presence cleanup on quit, and garbage collection of stale refs left by crashed apps.

### Hardening (second pass)
- Sessions are per branch; switching branches leaves the session first.
- Connection diagnostics in the panel: route and latency per person, and plain-language GitHub discovery errors (no write access, sign-in, network).
- Relay (TURN) servers configurable per repository in `.drawio/live.json` (static logins, coturn shared secret, or a token URL), tested in unit tests. No live TURN server has been tested (installing coturn was not permitted in that session).
- Adaptive GitHub polling: 2.5 seconds while someone is joining, 8 seconds otherwise.
- Bounded incoming messages; an edit that can't be applied triggers a resync instead of breaking the session.
- Network splits: edits from both sides survive when the groups reconnect. Failed direct connections are retried after a minute.
- Discard and Restore warn when they would change the diagram for people in the session.
- Performance: only touched pages are copied and diffed. On a 10,000-shape, 5-page diagram, ~15 ms per edit (was ~100 ms).
- `test/e2e/`: committed multi-instance scenarios (handoff, partition, relay, stress); `test/e2e/run-all.sh`.

### Verified
- `npm test`: 360 tests pass; `test/e2e/run-all.sh`: 12 of 12 checks pass (including `src/test/git-service.test.js` and `src/test/live.test.js`).
- Scripted three-person scenario (start, edit, hard-kill the host while another person edits, stale rejoin): converges with no lost edits.
- Concurrent stress test (2 × 40 random edits on the same shapes): identical checksums on both sides.
- Internet-only path (LAN disabled with `DRAWIO_LIVE_NO_LAN=1`): connects in about 8 seconds via refs on the remote.
- Packaged arm64 `.app` runs, with the source-control UI and live session loading from asar and the `drawio-git` scheme registered.

## Not done or known limitations (next steps, roughly by priority)

1. **Test with two Macs on different networks.** Done so far:
   - Signalling through hidden refs on real github.com (this fork): presence seen after 2.8 seconds, a handshake delivered in 4.2 seconds, nothing left behind.
   - Peers that can't connect directly are relayed through a peer they share (tested by blocking a direct link: the blocked person joined, synced and edited through the third person).

   Not covered: no peer reachable at all (two people only, both behind strict NATs). That needs a TURN server (e.g. Cloudflare, metered.ca or your own coturn), configured per repository in `.drawio/live.json` (see live-collaboration.md); the config is unit-tested but no live TURN relay has been tested. Polling GitHub (2.5s while someone joins, 8s otherwise) hasn't been checked against GitHub's limits over long sessions.
2. **Read-only collaborators** (no push access) can't write signalling refs, so over the internet they can only join via the LAN. Could fall back to Gists or GitHub Discussions for signalling.
3. **Code signing and notarisation.** The `.app`/`.dmg` is unsigned. It runs when built locally, but a downloaded copy is blocked by Gatekeeper (right-click → Open). Needs an Apple Developer ID; `build/` already has notarize support upstream (`@electron/notarize`).
4. **macOS Local Network permission.** On first use macOS may ask to allow local network access. `NSLocalNetworkUsageDescription` is set; test the prompt on a clean machine.
5. **Undo across live edits.** Remote edits are applied outside your undo history (as in draw.io's own real-time mode). Undoing your own edit after someone else changed the same shape can overwrite theirs.
6. **Large diagrams.** Each edit clones the pages and diffs them (like draw.io's realtime). Fine for normal diagrams; profile very large ones (thousands of shapes, many pages).
7. **Comments.** Mentions and notifications aren't implemented. Comments in `.drawio.svg`/`.png` diagrams also use the sidecar file.
8. **Semantic merge for `.drawio.svg`/`.drawio.png`.** These are resolved as whole-file mine/theirs.
9. **Upstream drawio updates.** Everything is injected from the desktop repo; the `drawio` submodule is untouched. After updating the submodule, re-run the tests and the manual scenarios. The renderer relies on these EditorUi/DrawioFile APIs: `diffPages`, `patchPages`, `getPagesForNode`, `updatePageRoot`, `getHashValueForPages`, `DrawioFile.patch/reloadFile/fileChanged`, `LocalFile.save`, `refreshCommentCache`, `windowResized` (used to capture the app instance).
10. **Windows/Linux.** Code is cross-platform in principle (PATH handling is Mac-specific) but has only been tested on macOS.

## How to test manually

See `doc/live-collaboration.md`. For multi-instance testing on one Mac, start instances with different `--user-data-dir` values and `--remote-debugging-port`, e.g.:

```
./node_modules/.bin/electron . --user-data-dir=/tmp/ud-alice /path/to/clone-a/diagram.drawio
./node_modules/.bin/electron . --user-data-dir=/tmp/ud-bob   /path/to/clone-b/diagram.drawio
```

`window.__drawioGit.live.trace` in DevTools shows the connection events of a window.
