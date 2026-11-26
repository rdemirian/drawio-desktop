# Testing status and test plan

> **Status: in testing. Not production ready.**

This fork adds GitHub source control and live collaboration to draw.io desktop for macOS.
Use it on test repositories, not on diagrams you can't afford to lose, until the open items
below have been checked.

## What has been tested

| Area | How | Result |
|---|---|---|
| Unit tests (git service, merge, live crypto, signalling, relay config) | `npm test` | 360 passing |
| Several people live on one Mac: host hand-off, network split, relaying through a teammate, concurrent edits | `test/e2e/run-all.sh` | 12/12 checks pass |
| Signalling over real github.com | Hidden refs on this fork | Presence in ~2.8s, handshake in ~4.2s, no refs left behind |
| Large diagrams | 10,000 shapes | ~15 ms per edit |
| Packaged Mac app | `dist/draw.io-arm64-*.dmg` | Opens, source control and live work |

## Not tested yet

1. **Two Macs on different networks** (the real-world case). The steps are below.
2. **Relay (TURN) server.** Needed when both people's networks block direct connections. The configuration in `.drawio/live.json` is unit-tested only.
3. **Unsigned app on a clean Mac.** Gatekeeper, and the macOS Local Network prompt.
4. **Long sessions** against GitHub's rate limits.
5. **Read-only collaborators.** They can't write signalling refs, so they can only join over the same local network.
6. **Windows and Linux.**

See [HANDOFF.md](HANDOFF.md) for the full list.

## Two-Mac test (different networks)

### You need
- Two **Apple Silicon** Macs. The build is arm64 only.
- Two separate internet connections, eg. two homes, or home Wi-Fi plus a phone hotspot. Neither person should be on the company network or a VPN. If you share a network, you only test local discovery.
- A private test repository containing one `.drawio` file. Both people need **Write** access, because signalling goes through hidden refs in the repository.

### Setup on each Mac
1. Install the DMG and drag draw.io to Applications.
2. The app is unsigned, so the first launch is blocked. Run `xattr -cr /Applications/draw.io.app` or right-click the app and choose **Open**.
3. Get git working with GitHub:
   ```
   xcode-select --install          # only if git is missing
   brew install gh && gh auth login && gh auth setup-git
   ```

### Steps
1. Person A opens the diagram first and becomes the host. They choose **File → Share…** and send the link.
2. Person B opens the link. The app clones the repository and opens the diagram. They can also use **File → Clone GitHub Repository…**.
3. Within ~5–10s each person appears in the other's Source Control panel (⇧⌘G). It should say **over the internet**. If it says **same network**, the test is not valid.

### Checklist
- [ ] Cursors and edits show on both sides
- [ ] Comments arrive on the other side
- [ ] Host closes the diagram: the other person keeps editing and becomes host
- [ ] Host reopens it: they rejoin and receive the changes
- [ ] One person turns off Wi-Fi for ~30s while both edit: after reconnecting, both people's edits survive
- [ ] One person commits and pushes: the other is told someone pushed and can pull, with merge and conflicts shown

### If you never see each other
- Read the reason in the panel. The most common one is no write access to the repository.
- Open the developer tools and run `window.__drawioGit.live.trace`. Keep the output for the bug report.
- If you can see each other but never connect, both networks block direct connections. Add a relay server in `.drawio/live.json`, as described in [live-collaboration.md](live-collaboration.md).

## Automated tests

```
npm test                 # unit tests
test/e2e/run-all.sh      # multi-instance live scenarios on one Mac (see test/e2e/README.md)
```
