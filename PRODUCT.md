# Product

## Register

product

## Users

The primary users are implementation, data, and customer-success staff maintaining NL2SQL semantic configuration during customer acceptance. They are often debugging customer questions under time pressure, comparing generated SQL with business rules, and adjusting semantics so the question-answering agent behaves predictably.

## Product Purpose

This tool turns scattered natural-language semantic notes into governed, inspectable configuration. It should let maintainers define business metrics, table scope, filters, rule injection stages, and validation questions without relying on long prompt text. Success means a maintainer can understand what a semantic entry does, edit it safely, and inspect the structured output that will drive SQL generation.

## Brand Personality

Calm, precise, operational. The interface should feel like a serious configuration console for data governance: dense enough for repeated work, but not cryptic. It should build trust through consistent controls, explicit structure, and visible execution output.

## Anti-references

Avoid marketing-style dashboards, decorative cards, oversized hero sections, colorful but meaningless panels, and prompt-only configuration surfaces. Avoid hiding the actual structured output behind vague natural-language descriptions. Avoid layouts that force users to scroll through unrelated content before finding the entry they are editing.

## Design Principles

1. Structure beats prose: natural-language rules may explain intent, but executable fields must carry the actual behavior.
2. List manages, modal edits: the main page should help users find and compare semantic entries; detailed configuration belongs in the entry editor.
3. Show the generated contract: every editable semantic entry should expose the structured JSON that downstream retrieval and SQL generation will consume.
4. Use progressive disclosure: common metric configuration should be easy, while advanced SQL and injection behavior remain available without crowding the default path.
5. Preserve operational density: this is a maintenance tool, so compact tables, stable alignment, and predictable controls matter more than visual drama.

## Accessibility & Inclusion

Target WCAG AA contrast for text and controls. Support keyboard navigation for buttons, form fields, and modals. Avoid color-only status cues; use labels or structure alongside status color. Motion should be minimal and respect reduced-motion preferences.
