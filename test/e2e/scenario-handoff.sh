#!/bin/bash
# Three people edit; the host is killed while someone edits; the host comes
# back with a stale file. Nothing may be lost and everyone must converge.
source "$(dirname "$0")/common.sh"
stopall; reset alice bob carol
launch alice; nap 1; launch bob; nap 1; launch carol; nap 8
check "full mesh at start" '[ "$(readypeers alice)$(readypeers bob)$(readypeers carol)" = "222" ]'
setvalue alice web "Web by Alice"; setvalue bob db "DB by Bob"; nap 1
kill9 alice
setvalue carol api "Gateway by Carol"
nap 10
reset alice; launch alice; nap 8
A=$(state alice); B=$(state bob); C=$(state carol)
echo "  alice: $A"; echo "  bob:   $B"; echo "  carol: $C"
check "everyone converged" '[ "$A" = "$B" ] && [ "$B" = "$C" ]'
check "no edit lost" '[[ "$B" == *"Web by Alice | DB by Bob | Gateway by Carol"* ]]'
stopall; exit $FAILED
