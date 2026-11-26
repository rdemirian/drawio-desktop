# Live collaboration

Everyone who has the same diagram open (same GitHub repository, same file) edits it together in real time. You see each other's cursors, selections and edits as they happen, what each person is doing ("editing text of “API Gateway”"), and an activity feed. You can follow someone to keep their view on screen, and comment on shapes.

No server, account, key or password is involved.

## How people find each other

The person who opens the diagram first is the **host**. Everyone who opens it after joins them. When the host leaves, the person who has been in the session longest takes over automatically: every participant is connected to every other one (a mesh), so nobody has to reconnect.

Participants find each other in two ways, both automatic:

- **Same network** (office, home, VPN with multicast): UDP multicast on the local network. Connects in about a second.
- **Over the internet:** through the GitHub repository itself. Each app writes a tiny presence record and its connection handshakes to hidden refs (`refs/drawio-live/<id>/…`). These are not branches or tags: they don't show up on GitHub, in clones, or in Actions. Connecting takes a few seconds; after that the session runs directly between the participants (WebRTC data channels, encrypted with DTLS). You can turn this off under *Collaboration settings*.

The session key is derived from the repository (root commit, remote and file path). Only people who have the repository can derive it, so only they can join, or read the handshakes on GitHub. **Access to the GitHub repository is the permission.**

## Sharing and starting again

- **Share** (in the panel or File menu) gives the diagram's GitHub link. Anyone with access who opens it in draw.io (File → Open GitHub Link…, or the `drawio-git://` link that opens the app directly) gets the diagram. The first time, the repository is downloaded. They then join whoever has it open.
- **Invite** adds a GitHub collaborator, using the GitHub CLI and your account.
- **When everyone has closed the diagram** there is nothing to restart. The diagram is just the file in the repository, and the next person who opens it starts a new session. Live edits from others mark your copy as unsaved, and with autosave on they are saved for you. Commit & Sync keeps the latest version on GitHub for next time.

## How edits stay consistent

- Edits are draw.io diffs, the same engine draw.io uses for its own real-time collaboration. You see your own edits immediately. They also go to the host, which applies everyone's edits in a single order and sends them to all participants. Edits that arrive out of order are re-applied in the host's order.
- Every 2 seconds the host sends a checksum of the diagram. Anyone whose diagram differs asks the host for the full diagram, keeping their own edits that haven't been sent yet.
- When the host changes, any edits the old host never confirmed are sent again to the new host. Duplicates are ignored by ID.
- If two people can't connect directly (strict firewalls), their messages travel through someone they are both connected to.
- Peers check on each other every 2 seconds. Someone who hasn't been heard from for 7 seconds, or whose connection fails, is treated as gone. Quitting the app announces the departure immediately.
- If someone joins with a different committed version of the diagram than the host, the panel warns them to pull or push before committing.

## Comments

draw.io's comments window (comments on the diagram or on shapes, with replies and resolve) works for diagrams in folders. Comments sync live and are stored next to the diagram as `<diagram>.comments.jsonl`, one JSON object per line. Edits append a newer version of a comment, so git's union merge (set up automatically in `.git/info/attributes`) combines everyone's comments without conflicts.

## Code

- `src/main/live/`: discovery and signalling in the main process (`lan-bus.js` for the LAN, `git-signal.js` for GitHub refs, `live-crypto.js` for session keys, `index.js` for IPC and comment storage).
- `src/main/git/renderer/live-ui.js`: the WebRTC mesh, host election, edit sync, presence, cursors, comments backend and UI.
- Tests: `src/test/live.test.js`.
