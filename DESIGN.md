# Deadwax design

## Overview

Deadwax is a crate of records you flip through, pull out and play. It should feel like handling the real thing: the sleeves move as soon as you touch them, the artwork is sharp the moment a record is out, and the glow behind a playing record drifts without a stutter. **Performance comes first.** An effect that costs frames doesn't ship, however good it looks in a still.

This document starts with the frame budget and what measuring the crate taught us (DWX-20, RFC-002 "4. The UI" and "6. `DESIGN.md` starts here"). The colour rules, the type and the interaction patterns come in with the tickets that build them (DWX-21 to DWX-26), and DWX-27 makes it one document.

## The frame budget

| | Target |
|---|---|
| Flipping through the crate, the real collection and a 400-record crate | A steady 60 fps |
| A pulled-out sleeve's large artwork | Drawn within 100 ms of pulling it out |
| The glow's drift behind a playing record | Drops no frames |

These are a starting point (Will's call in RFC-002). We tighten them if they turn out too easy.

## How we measure

FRAMES_HOW

## What we measured

MEASUREMENTS

## Rules

RULES

## Do's and Don'ts

DOS
