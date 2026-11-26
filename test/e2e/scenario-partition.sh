#!/bin/bash
# Alice and Bob lose their connection, both keep editing, then reconnect.
# Both people's offline edits must survive.
source "$(dirname "$0")/common.sh"
stopall; reset alice bob
launch alice; nap 2; launch bob; nap 8
check "connected" '[ "$(readypeers alice)$(readypeers bob)" = "11" ]'
CUT='var L=window.__drawioGit.live; var ids=Object.keys(L.peers); L.blockDirect={}; ids.forEach(function(id){ L.blockDirect[id]=true; L.dropPeer(id, true); }); ids.length'
ev alice "$CUT" > /dev/null; ev bob "$CUT" > /dev/null; nap 3
check "split: both alone and hosting" '[ "$(ev alice "window.__drawioGit.live.isHost()")$(ev bob "window.__drawioGit.live.isHost()")" = "truetrue" ]'
setvalue alice web "Alice offline"; setvalue bob db "Bob offline"; setvalue bob api "Bob offline too"; nap 1
HEAL='var L=window.__drawioGit.live; L.blockDirect=null; L.failures={}; "ok"'
ev alice "$HEAL" > /dev/null; ev bob "$HEAL" > /dev/null; nap 14
A=$(state alice); B=$(state bob)
echo "  alice: $A"; echo "  bob:   $B"
check "reconnected" '[ "$(readypeers alice)$(readypeers bob)" = "11" ]'
check "converged" '[ "$A" = "$B" ]'
check "offline edits of both survived" '[[ "$A" == *"Alice offline | Bob offline | Bob offline too"* ]]'
stopall; exit $FAILED
