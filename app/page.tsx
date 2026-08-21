import { Suspense } from "react";
import SequencesView from "@/components/SequencesView";

// Sequence Desk: investor outreach sequences. The app edits and approves;
// Claude's daily run sends from Sergio's Gmail and writes results back.
export default function HomePage() {
  return (
    <Suspense fallback={<div className="loading-bar">Loading…</div>}>
      <SequencesView />
    </Suspense>
  );
}
