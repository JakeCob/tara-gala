"use client";

import { useState } from "react";
import { DEFAULT_PARTY, type Party } from "@/lib/party";
import PartyPicker from "./PartyPicker";
import PartyStage from "./PartyStage";
import { useSpawn } from "./useSpawn";

/**
 * The planner form on /plan. TG-15 owns the party: the stage above, the steppers below. TG-21 adds its date,
 * budget and vibe fields under the picker and reads `party` from here. Not saved between visits.
 */
export default function PlanForm() {
  const [party, setParty] = useState<Party>(DEFAULT_PARTY);
  const spawn = useSpawn();

  // Capture phase: a tap or key during a spawn finishes it before the button's click starts the next one
  return (
    <div className="flex flex-col gap-4" onPointerDownCapture={spawn.skip} onKeyDownCapture={spawn.skip}>
      <PartyStage party={party} spawning={spawn.active} step={spawn.step} fixedRows />
      <PartyPicker party={party} onChange={setParty} onAdd={(i) => spawn.start([i])} />
    </div>
  );
}
