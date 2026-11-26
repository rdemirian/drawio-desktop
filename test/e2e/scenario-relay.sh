#!/bin/bash
# Alice and Bob cannot connect directly (blocked); Bob must reach Alice, the
# host, through Carol.
source "$(dirname "$0")/common.sh"
stopall; reset alice bob carol
launch alice; nap 2; launch carol; nap 7
ev alice "var L=window.__drawioGit.live; var keep=Object.values(L.peers).filter(p=>p.ready).map(p=>p.id); L.blockDirect = new Proxy({}, {get: function(t, id) { return typeof id === 'string' && keep.indexOf(id) < 0; }}); 'ok'" > /dev/null
launch bob; nap 16
check "bob reaches alice through carol" '[ "$(ev bob "var L=window.__drawioGit.live; Object.values(L.peers).some(p=>p.ready && p.virtual && p.name==\"Alice Chen\")")" = "true" ]'
setvalue bob db "Bob via relay"; setvalue alice web "Alice via relay"; nap 5
A=$(state alice); B=$(state bob); C=$(state carol)
echo "  alice: $A"; echo "  bob:   $B"; echo "  carol: $C"
check "everyone converged" '[ "$A" = "$B" ] && [ "$B" = "$C" ]'
check "relayed edits arrived" '[[ "$A" == *"Alice via relay | Bob via relay"* ]]'
stopall; exit $FAILED
