"use strict";
/* Local command fast path for Issue #13.
 *
 * A small deterministic resolver for anchored single-action commands
 * ("click <target>", "fill <target> with <value>"). No network, no
 * model, no API key: pure functions over the command string and the
 * current production snapshot.
 *
 * Parsing and candidate ranking are separate and separately testable:
 *  - parseLocalCommand(text): command shape only. Never guesses.
 *  - matchTarget(elements, targetText): ranking over snapshot
 *    elements only. Never invents targets.
 *
 * Matching algorithm (documented; a similarity score is NOT model
 * confidence):
 *  1. Normalize the target and each candidate field: lowercase,
 *     trim, collapse whitespace, strip one layer of terminal
 *     punctuation and a leading article (the/a/an).
 *  2. Candidate fields per element, in order: accessible name; if a
 *     certain question exists, also "question + name" and the bare
 *     question (so repeated names like rating "1" stay
 *     distinguishable by their real context).
 *  3. Exact normalized equality on any field scores 1.0.
 *  4. Otherwise fuzzy score = 0.7 * meanTokenSim + 0.3 * levSim,
 *     where meanTokenSim averages, over target tokens, the best
 *     per-token similarity (1 - levenshtein/maxLen) against any
 *     field token, and levSim is the whole-string similarity. A
 *     single typo ("ful name") still scores high; unrelated words
 *     score near zero.
 *  5. ACCEPT_THRESHOLD = 0.75 with MIN_SEPARATION = 0.10 from the
 *     next-best element. Multiple exact matches, or a best match
 *     within the separation band, yield "ambiguous" with the
 *     COMPLETE candidate set: every exact match and every in-band
 *     rival. Valid matches are never truncated to meet a
 *     presentation cap, so the panel never shows an arbitrary
 *     subset as the whole choice. Below threshold yields "none".
 *  6. Ranking is by label score only. Disabled, readonly, and
 *     otherwise rejected controls are never filtered or redirected
 *     here: the executor remains authoritative and rejects them
 *     honestly with zero dispatches.
 *  7. A purely numeric target ("22") addresses the stable snapshot
 *     id el-22 when that element exists — unless the number is also
 *     an accessible name in the snapshot, in which case the id and
 *     the name(s) clarify against each other instead of one winning
 *     silently.
 */

const ACCEPT_THRESHOLD = 0.75;
const MIN_SEPARATION = 0.10;

// Whole-word markers checked against the COMMAND STRUCTURE only (never
// against a fill value, which is preserved verbatim and may contain
// ordinary words like "and", commas, or "not").
const NEGATION_WORDS = ["don't", "dont", "do not", "never", "cannot", "can't", "won't", "wouldn't", "shouldn't", "couldn't", "not"];
const COMPOUND_MARKERS = [" and ", " then ", " after ", " plus ", " followed by ", " also ", ",", ";", "&", " before "];

function normalizeLabel(text) {
  return String(text == null ? "" : text)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?,;:]+$/, "")
    .trim()
    .replace(/^(the|a|an)\s+/, "");
}

function stripTerminalPunctuation(text) {
  return String(text).trim().replace(/[.!?]+$/, "").trim();
}

function containsMarker(lowered, markers) {
  return markers.some((m) => {
    if (/^[a-z' ]+$/.test(m)) {
      const words = lowered.split(/[^a-z']+/);
      if (!m.includes(" ")) return words.includes(m);
      return lowered.includes(m);
    }
    return lowered.includes(m);
  });
}

function parseLocalCommand(rawText) {
  const raw = String(rawText == null ? "" : rawText).trim();
  if (!raw) return { kind: "empty" };
  const verb = raw.match(/^(click|fill)\b/i);
  if (!verb) return { kind: "unknown", reason: "not a supported command shape" };
  const action = verb[1].toLowerCase();
  const rest = raw.slice(verb[0].length).trim();
  if (!rest) return { kind: "unknown", reason: `no target after "${action}"` };

  if (action === "click") {
    const lowered = ` ${rest.toLowerCase().replace(/\s+/g, " ")} `;
    if (containsMarker(rest.toLowerCase(), NEGATION_WORDS)) {
      return { kind: "unknown", reason: "negated commands are not executed" };
    }
    if (containsMarker(lowered, COMPOUND_MARKERS)) {
      return { kind: "unknown", reason: "compound commands are not executed" };
    }
    const target = stripTerminalPunctuation(rest);
    if (!target) return { kind: "unknown", reason: "no target after \"click\"" };
    return { kind: "click", target, normalizedTarget: normalizeLabel(target) };
  }

  // fill: split the STRUCTURE from the VALUE first, then check markers
  // only against the structure. The value is preserved verbatim apart
  // from surrounding whitespace: never lowercased or rewritten.
  const withAt = rest.search(/\s+with\s+/i);
  if (withAt === -1) {
    if (/\s+with\s*$/i.test(rest)) return { kind: "unknown", reason: "no value after \"with\"" };
    return { kind: "unknown", reason: "fill needs \"with <value>\"" };
  }
  const targetRaw = rest.slice(0, withAt).trim();
  const value = rest.slice(withAt).replace(/^\s+with\s+/i, "").trim();
  if (!targetRaw) return { kind: "unknown", reason: "no target after \"fill\"" };
  if (!value) return { kind: "unknown", reason: "no value after \"with\"" };
  const loweredTarget = ` ${targetRaw.toLowerCase().replace(/\s+/g, " ")} `;
  if (containsMarker(targetRaw.toLowerCase(), NEGATION_WORDS)) {
    return { kind: "unknown", reason: "negated commands are not executed" };
  }
  if (containsMarker(loweredTarget, COMPOUND_MARKERS)) {
    return { kind: "unknown", reason: "compound commands are not executed" };
  }
  const target = stripTerminalPunctuation(targetRaw);
  if (!target) return { kind: "unknown", reason: "no target after \"fill\"" };
  return { kind: "fill", target, normalizedTarget: normalizeLabel(target), value };
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[b.length];
}

function tokenSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function fuzzyScore(targetNorm, fieldNorm) {
  if (!targetNorm || !fieldNorm) return 0;
  if (targetNorm === fieldNorm) return 1;
  const targetTokens = targetNorm.split(" ").filter(Boolean);
  const fieldTokens = fieldNorm.split(" ").filter(Boolean);
  const meanTokenSim = targetTokens.reduce((sum, t) => {
    let best = 0;
    for (const f of fieldTokens) best = Math.max(best, tokenSimilarity(t, f));
    return sum + best;
  }, 0) / targetTokens.length;
  const levSim = 1 - levenshtein(targetNorm, fieldNorm) / Math.max(targetNorm.length, fieldNorm.length);
  return 0.7 * meanTokenSim + 0.3 * levSim;
}

function candidateFields(element) {
  const fields = [element.name || ""];
  if (element.question && element.questionCertain) {
    fields.push(`${element.question} ${element.name || ""}`.trim());
    fields.push(element.question);
  }
  return fields.map((text) => ({ text, normalized: normalizeLabel(text) })).filter((f) => f.normalized);
}

function candidateLabel(element) {
  // Words first: the accessible name and its real question context
  // lead; the internal snapshot number is a secondary reference.
  const num = String(element.id || "").replace(/^el-/, "");
  const name = element.name || element.role || element.id;
  const context = element.question ? ` — ${element.question}${element.questionCertain === false ? " (uncertain)" : ""}` : "";
  const state = element.state && element.state.disabled ? " (disabled)"
    : element.state && element.state.readonly ? " (readonly)" : "";
  return `${name}${context}${state} (#${num})`;
}

function matchTarget(elements, targetText) {
  const list = Array.isArray(elements) ? elements : [];
  const targetNorm = normalizeLabel(targetText);
  if (!targetNorm) return { status: "none", reason: "empty target" };
  // Numeric addressing over stable snapshot ids (el-N). A number that
  // is ALSO an accessible name (e.g. rating option "1") must clarify
  // rather than silently prefer the id or the name.
  if (/^\d+$/.test(targetNorm)) {
    const byId = list.find((e) => e && e.id === `el-${targetNorm}`) || null;
    const byName = list.filter((e) => e && e.id !== (byId && byId.id)
      && normalizeLabel(e.name) === targetNorm);
    if (byId && byName.length === 0) {
      return { status: "match", element: byId, score: 1, via: "id", candidates: [] };
    }
    if (!byId && byName.length === 1) {
      return { status: "match", element: byName[0], score: 1, via: "name", candidates: [] };
    }
    if (!byId && byName.length === 0) {
      return { status: "none", reason: `no target numbered ${targetNorm} in this snapshot` };
    }
    return {
      status: "ambiguous",
      candidates: [byId, ...byName].filter(Boolean).map((element) => ({
        elementId: element.id, score: 1, label: candidateLabel(element),
      })),
    };
  }
  const scored = [];
  for (const element of list) {
    if (!element || typeof element.id !== "string") continue;
    let best = 0;
    let via = "";
    for (const field of candidateFields(element)) {
      const s = fuzzyScore(targetNorm, field.normalized);
      if (s > best) { best = s; via = field.text; }
    }
    scored.push({ element, score: best, via });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < ACCEPT_THRESHOLD) {
    return { status: "none", reason: "no confident match", candidates: [] };
  }
  const exacts = scored.filter((s) => s.score === 1);
  const second = scored[1] ? scored[1].score : 0;
  if (exacts.length > 1 || (best.score - second) < MIN_SEPARATION) {
    const pool = exacts.length > 1 ? exacts : scored.filter((s) => (best.score - s.score) < MIN_SEPARATION);
    return {
      status: "ambiguous",
      candidates: pool.map((s) => ({
        elementId: s.element.id,
        score: Math.round(s.score * 1000) / 1000,
        label: candidateLabel(s.element),
      })),
    };
  }
  return { status: "match", element: best.element, score: Math.round(best.score * 1000) / 1000, via: best.via, candidates: [] };
}

const SeeyableCommands = {
  ACCEPT_THRESHOLD,
  MIN_SEPARATION,
  parseLocalCommand,
  matchTarget,
  normalizeLabel,
};

if (typeof globalThis !== "undefined") globalThis.SeeyableCommands = SeeyableCommands;
if (typeof module !== "undefined" && module.exports) module.exports = SeeyableCommands;
