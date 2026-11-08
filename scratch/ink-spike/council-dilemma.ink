// Council dilemma spike story for issue #188.
// Mirrors ADR-0010: Ink owns dialogue; sim owns state.
// simSeed is set by the host (mock sim) before the story starts.
// sim_adjust_favour is the single allowlisted external function.

EXTERNAL sim_adjust_favour(delta)

VAR simSeed = 0
VAR favour = 50
VAR grain = 120

~ SEED_RANDOM(simSeed)
-> council_begins

=== council_begins ===
The council takes its seats. The granary holds {grain} measures, and the Emperor's tithe falls due at month's end. Word from the docks: {~sails|smoke|songs} on the water this morning.
* [Raise the grain levy] -> raise_levy
* [Hold the levy steady] -> hold_levy

=== raise_levy ===
~ grain += 30
~ temp favourDelta = -8
~ sim_adjust_favour(favourDelta)
~ favour += favourDelta
The levy rises. The granary swells to {grain} measures, but the merchants' benches murmur.
-> second_motion

=== hold_levy ===
~ temp favourDelta = 5
~ sim_adjust_favour(favourDelta)
~ favour += favourDelta
The levy holds. The benches settle, though the tithe chest will be thin.
-> second_motion

=== second_motion ===
A second motion: shall the harbour chain be raised against smugglers?
~ temp watchRoll = RANDOM(1, 6)
The watch captain rattles a die for luck: {watchRoll}.
* [Raise the chain] -> chain_up
* [Leave the harbour open] -> chain_down

=== chain_up ===
The chain rises, groaning from the harbour mouth.
-> council_ends

=== chain_down ===
The harbour stays open. Night boats will do as they please.
-> council_ends

=== council_ends ===
{ favour >= 50:
    The council adjourns in good humour. Imperial favour stands at {favour}.
- else:
    The council adjourns under a cloud. Imperial favour stands at {favour}.
}
-> END
