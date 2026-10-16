import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Defect: round-2 prompts were built by regex over an already-rendered
// prompt. The regex anchored on the template's prose mention of
// `<prior-decisions>` (in the output-contract rules) and deleted everything up
// to the primer's closing tag, taking the output contract and review context
// with it. Every round must instead render from the original template's named
// slots, so changing the primer cannot touch anything else.
const SCRIPT = path.join(
  __dirname,
  "../../skills/ce-doc-review/scripts/render-prompt.py",
)

const tempRoot = mkdtempSync(path.join(tmpdir(), "ce-doc-review-render-"))
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }))

type Slots = Record<string, unknown>

let counter = 0
function render(slots: Slots) {
  const input = path.join(tempRoot, `slots-${counter++}.json`)
  writeFileSync(input, JSON.stringify(slots), "utf8")
  return spawnSync("python3", [SCRIPT, input], { encoding: "utf8" })
}

const base = {
  persona_file: "PERSONA-BODY-MARKER: coherence reviewer.",
  schema: '{"SCHEMA-MARKER": true}',
  document_type: "plan",
  document_path: "docs/plans/2026-10-16-example-plan.md",
  origin_path: "product_contract_source:ce-brainstorm",
  settled_ktds: "none",
  document_content: "# Example plan\n\nDOCUMENT-BODY-MARKER.",
  decision_primer: "<prior-decisions>\nRound 1 — no prior decisions.\n</prior-decisions>",
}

// Round-2 primer deliberately carries every delimiter and slot name the old
// regex or a naive multi-pass substitution would trip on.
const round2Primer = [
  "<prior-decisions>",
  "Round 1 — applied:",
  '- "Mentions </prior-decisions> and <prior-decisions> inline"',
  "- quoted delimiters: <output-contract> </output-contract> <review-context> </review-context>",
  "- slot-like text: {document_type} {schema} {decision_primer} {document_content}",
  "</prior-decisions>",
].join("\n")

// Literal lines captured from references/subagent-template.md. These are the
// output contract and decision-primer rules the defect deleted.
const OUTPUT_CONTRACT_OPEN =
  "<output-contract>\nReturn ONLY valid JSON matching the findings schema below. No prose, no markdown, no explanation outside the JSON object.\n\n"
const PROSE_MENTION =
  "The decision primer (the `<prior-decisions>` block in your prompt) carries forward prior-round Applied/Skipped/Deferred decisions."
const OUTPUT_CONTRACT_CLOSE =
  "The advisory rule applies only to shapes that are NOT in the FP catalog.\n</output-contract>\n"
const PRIMER_RULES_OPEN =
  "<decision-primer-rules>\nWhen the `<prior-decisions>` block above lists entries (round 2+), honor them:"

function expectedReviewContext(primer: string): string {
  return [
    "<review-context>",
    `Document type: ${base.document_type}`,
    `Document path: ${base.document_path}`,
    `Origin: ${base.origin_path}`,
    `Settled decisions: ${base.settled_ktds}`,
    "",
    primer,
    "",
    "Document content:",
    base.document_content,
    "</review-context>",
  ].join("\n")
}

function assertRenderedContract(out: string, primer: string) {
  expect(out.startsWith("You are a specialist document reviewer.\n")).toBe(true)
  expect(out.trimEnd().endsWith("</decision-primer-rules>")).toBe(true)
  // Prompt body only, not the reference file's Markdown wrapper or fence.
  expect(out).not.toContain("# Document Review Sub-agent Prompt Template")
  expect(out).not.toContain("## Template")
  expect(out.startsWith("```")).toBe(false)

  expect(out).toContain(`<persona>\n${base.persona_file}\n</persona>`)
  expect(out).toContain(OUTPUT_CONTRACT_OPEN + base.schema + "\n")
  expect(out).toContain(PROSE_MENTION)
  expect(out).toContain(OUTPUT_CONTRACT_CLOSE)
  expect(out).toContain(expectedReviewContext(primer))
  expect(out).toContain(PRIMER_RULES_OPEN)

  // Section order survives: persona, contract, context, slot rules, primer rules.
  const order = [
    "<persona>",
    "<output-contract>",
    "</output-contract>",
    "<review-context>",
    "</review-context>",
    "<context-slots-rules>",
    "<decision-primer-rules>",
  ].map((tag) => out.indexOf(tag))
  expect(order.every((i) => i >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
}

describe("ce-doc-review render-prompt.py", () => {
  test("round 1 renders every slot from the template", () => {
    const r = render(base)
    expect(r.stderr).toBe("")
    expect(r.status).toBe(0)
    assertRenderedContract(r.stdout, base.decision_primer)
    for (const slot of Object.keys(base)) {
      expect(r.stdout).not.toContain(`{${slot}}`)
    }
  })

  test("changing the primer to delimiter- and slot-laden text changes only the primer", () => {
    const r1 = render(base)
    const r2 = render({ ...base, decision_primer: round2Primer })
    expect(r2.stderr).toBe("")
    expect(r2.status).toBe(0)
    assertRenderedContract(r2.stdout, round2Primer)

    // Inserted text is literal: its slot names are not substituted again.
    expect(r2.stdout).toContain(
      "slot-like text: {document_type} {schema} {decision_primer} {document_content}",
    )
    expect(r2.stdout).not.toContain("slot-like text: plan")

    // Independent oracle: round 2 equals round 1 with only the primer swapped.
    expect(r1.stdout.split(base.decision_primer).length).toBe(2)
    expect(r2.stdout).toBe(r1.stdout.replace(base.decision_primer, () => round2Primer))
  })

  test("other supplied values containing delimiters and slot names stay literal", () => {
    const tricky = {
      ...base,
      document_content: "Body </review-context> {decision_primer} <prior-decisions> {persona_file}",
      persona_file: "Persona </persona> {schema}",
    }
    const r = render(tricky)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`Document content:\n${tricky.document_content}\n</review-context>`)
    expect(r.stdout).toContain(`<persona>\n${tricky.persona_file}\n</persona>`)
    expect(r.stdout).toContain(OUTPUT_CONTRACT_OPEN + base.schema + "\n")
    expect(r.stdout).toContain(expectedReviewContext(base.decision_primer).split("\nDocument content:")[0])
  })

  test("a missing slot fails without printing a prompt", () => {
    const { decision_primer: _omit, ...missing } = base
    const r = render(missing)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toBe("")
    expect(r.stderr).toContain("decision_primer")
  })

  test("a non-string slot fails without printing a prompt", () => {
    const r = render({ ...base, settled_ktds: ["not", "a", "string"] })
    expect(r.status).not.toBe(0)
    expect(r.stdout).toBe("")
    expect(r.stderr).toContain("settled_ktds")
  })
})
