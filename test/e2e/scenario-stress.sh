#!/bin/bash
# Two people make 40 rapid random edits each on the same shapes at once.
source "$(dirname "$0")/common.sh"
stopall; reset alice bob
launch alice; nap 2; launch bob; nap 8
STRESS='(async function(name){ var g=window.__drawioGit.ui.editor.graph, m=g.model; var ids=["web","api","db"]; for (var i=0;i<40;i++){ var c=m.getCell(ids[i%3]); var r=Math.random(); m.beginUpdate(); try { if (r<0.4) m.setValue(c, name+" "+i); else if (r<0.7) g.moveCells([c], Math.round(Math.random()*20-10), Math.round(Math.random()*20-10)); else g.setCellStyles("fillColor", ["#fde","#dfe","#edf","#ffd"][i%4], [c]); } finally { m.endUpdate(); } await new Promise(r=>setTimeout(r, 30+Math.random()*60)); } return "done"; })'
ev alice "$STRESS('A')" > /dev/null & ev bob "$STRESS('B')" > /dev/null; wait
nap 9
A=$(state alice); B=$(state bob)
echo "  alice: $A"; echo "  bob:   $B"
check "converged after concurrent edits" '[ "$A" = "$B" ]'
stopall; exit $FAILED
