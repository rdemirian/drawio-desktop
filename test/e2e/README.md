# End-to-end tests

Real app instances (Alice, Bob and Carol), each with its own clone of a test repository, driven over the Chrome DevTools protocol. macOS only, and they need `npm install` to have been run.

```
test/e2e/run-all.sh
```

- `setup.sh`: a bare repository standing in for GitHub, plus three teammates' clones, under `$E2E_DIR` (default `/tmp/drawio-e2e`).
- `scenario-handoff.sh`: three people edit; the host is killed while someone edits; the host returns with a stale file. Checks that nothing is lost and everyone converges.
- `scenario-stress.sh`: two people make 40 rapid random edits each on the same shapes at once. Checks that they converge.
- `scenario-relay.sh`: Alice and Bob can't connect directly; Bob joins through Carol.

Each check prints PASS or FAIL, and scripts exit non-zero on failure. Uses DevTools ports 9333–9335 and closes the instances at the end. `window.__drawioGit.live.trace` in an instance shows its connection events.
