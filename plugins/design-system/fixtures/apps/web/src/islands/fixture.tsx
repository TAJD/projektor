// fixture.tsx — input to `cofferdam check` for the DesignSystemConvention
// plugin (PROJ-527, Task 14 scaffold). Sections below are placeholders for
// the four rules landing in Tasks 15-18; each section is currently empty —
// no findings are expected yet.

// Rule 1: raw color literal

const styleA = { color: "#fff" };
const styleB = { backgroundColor: "rgba(0,0,0,0.1)" };
const styleC = { color: "var(--text)" };
const link = <a href="#add">Add</a>;

// Rule 2: import boundary

import { Select } from "./ui/Select";

// Positive: hand-rolled .btn markup with no Button import anywhere in this
// file — flagged.
const handRolledButton = <button class="btn">Click</button>;

// Regression: this section imports Select (an unrelated primitive family)
// but still has a raw .btn-classed element — proves per-primitive-family
// gating isn't silenced by an unrelated islands/ui import. Named for
// clarity per the task spec.
function HandRolledStillFlaggedDespiteUnrelatedImport() {
  return (
    <div>
      <Select options={[]} />
      <button class="btn">Still flagged</button>
    </div>
  );
}

// Negative: an element correctly using the Button component — no raw
// class="btn" literal, so it's never a Rule 2 candidate regardless of
// import state. Deliberately NOT importing Button here: the importedNames
// set built from ImportDeclaration is file-scoped, not scope-local, so
// importing Button anywhere in this file would also suppress the
// positive case above — fixtures aren't type-checked (tsconfig only
// includes src/index.ts), so the missing import doesn't break `npm run
// build`.
function UsesButtonCorrectly() {
  return <Button>OK</Button>;
}

// Rule 3: new primitive-shaped CSS class

// Rule 4: inline token-shaped style
