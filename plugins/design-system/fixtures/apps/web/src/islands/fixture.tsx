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

import { Badge } from "./ui/Badge";

// Positive: hand-rolled .btn markup with no Button import anywhere in this
// file — flagged.
const handRolledButton = <button class="btn">Click</button>;

// Regression: this section imports Badge (an unrelated primitive family)
// but still has a raw .btn-classed element — proves per-primitive-family
// gating isn't silenced by an unrelated islands/ui import. Named for
// clarity per the task spec. (Select is deliberately NOT imported here —
// it's reserved for the select-* positive/negative cases below.)
function HandRolledStillFlaggedDespiteUnrelatedImport() {
  return (
    <div>
      <Badge>Label</Badge>
      <button class="btn">Still flagged</button>
    </div>
  );
}

// Positive: hand-rolled .select-menu markup with no Select import anywhere
// in this file — flagged.
const handRolledSelectMenu = <div class="select-menu">Menu</div>;

// Negative (PROJ-560 regression): "popover-select-menu" is a genuine
// Popover primitive class, not a standalone select-* token. The select-*
// pattern must only match at a real class-token boundary (start of string
// or preceded by whitespace) — "-" is a non-word char, so a naive \b
// anchor false-positived inside "popover-select-menu". Popover is
// imported (not Select), so this must not be flagged under either family.
import { Popover } from "./ui/Popover";

function PopoverSelectMenuNotFlaggedAsSelect() {
  return <Popover class="popover-select-menu">Content</Popover>;
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

// Positive: hand-rolled CSS-in-JS-shaped rule for a new dropdown/menu class
// — matches both the "dropdown" and "menu-" alternatives — flagged.
const dropdownStyles = `
.my-custom-dropdown-menu {
  position: absolute;
}
`;

// Negative: a CSS-in-JS-shaped rule for an unrelated class name — doesn't
// match any of the primitive-name alternatives, so it's never flagged.
const widgetStyles = `
.my-widget {
  display: flex;
}
`;

// Rule 4: inline token-shaped style

// Positive: inline style with token-shaped hardcoded values matching .btn's
// border-radius and padding — flagged.
const inlineTokenShaped = <div style={{ borderRadius: "4px", padding: "0.375rem 0.75rem" }}>Box</div>;

// Negative: 12px isn't in the token-shaped list — never flagged.
const inlineNotTokenShaped = <div style={{ borderRadius: "12px" }}>Box</div>;
