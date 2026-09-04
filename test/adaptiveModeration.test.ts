import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADAPTIVE_LEARNING_HORIZON_MS,
  classifyModerationLanguage,
  extractAdaptiveModerationFeatures,
  scoreAdaptiveModerationEvidence,
} from "../src/languageModeration.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");

describe("adaptive moderation features", () => {
  it("derives deterministic bounded hashes without retaining raw message content", () => {
    const uniqueTokens = Array.from(
      { length: 80 },
      (_, index) => `word${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`
    );
    const raw = `bang lu prnah wd ga dri agenton ${uniqueTokens.join(" ")}`;
    const features = extractAdaptiveModerationFeatures(raw);
    const corrected = extractAdaptiveModerationFeatures("bang lu pernah wd ga dari agenton");
    const typo = extractAdaptiveModerationFeatures("bang lu prnah wd ga dri agenton");

    assert.ok(features);
    assert.ok(corrected);
    assert.ok(typo);
    assert.equal(features.tokenHashes.length, 32);
    assert.ok(features.trigramHashes.length <= 128);
    assert.match(features.fingerprintHash, /^[a-f0-9]{64}$/);
    assert.ok([...features.tokenHashes, ...features.trigramHashes].every((value) => /^[a-f0-9]{64}$/.test(value)));
    assert.equal(JSON.stringify(features).includes("agenton"), false);
    assert.equal(corrected.fingerprintHash, typo.fingerprintHash);
  });

  it("fingerprints the ordered normalized message without feature-set collisions", () => {
    const simple = extractAdaptiveModerationFeatures("foo bar");
    const repeated = extractAdaptiveModerationFeatures("foo foo bar");
    const reordered = extractAdaptiveModerationFeatures("bar foo");
    const normalized = extractAdaptiveModerationFeatures("bang lu pernah wd ga dari agenton");
    const abbreviated = extractAdaptiveModerationFeatures("bang lu prnah wd ga dri agenton");
    assert.ok(simple);
    assert.ok(repeated);
    assert.ok(reordered);
    assert.ok(normalized);
    assert.ok(abbreviated);
    assert.notEqual(simple.fingerprintHash, repeated.fingerprintHash);
    assert.notEqual(simple.fingerprintHash, reordered.fingerprintHash);
    assert.equal(normalized.fingerprintHash, abbreviated.fingerprintHash);

    const commonPrefix = Array.from(
      { length: 40 },
      (_, index) => `token${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`
    ).join(" ");
    const firstTail = extractAdaptiveModerationFeatures(`${commonPrefix} firsttail`);
    const secondTail = extractAdaptiveModerationFeatures(`${commonPrefix} secondtail`);
    assert.ok(firstTail);
    assert.ok(secondTail);
    assert.deepEqual(firstTail.tokenHashes, secondTail.tokenHashes);
    assert.deepEqual(firstTail.trigramHashes, secondTail.trigramHashes);
    assert.notEqual(firstTail.fingerprintHash, secondTail.fingerprintHash);
  });

  it("requires repeated recent evidence, caps contribution, and allows an exact confirmed repeat", () => {
    const recent = NOW.toISOString();
    const stale = new Date(NOW.getTime() - ADAPTIVE_LEARNING_HORIZON_MS - 1).toISOString();
    assert.equal(
      scoreAdaptiveModerationEvidence(
        {
          exactOwnerConfirmed: false,
          families: [
            {
              token: { kind: "TOKEN", seenCount: 1, positiveCount: 1, lastPositiveAt: recent },
              trigrams: [],
              totalTrigramCount: 0,
            },
          ],
        },
        NOW
      ),
      0
    );
    assert.equal(
      scoreAdaptiveModerationEvidence(
        {
          exactOwnerConfirmed: false,
          families: [
            {
              token: { kind: "TOKEN", seenCount: 3, positiveCount: 3, lastPositiveAt: recent },
              trigrams: [],
              totalTrigramCount: 0,
            },
            {
              token: { kind: "TOKEN", seenCount: 3, positiveCount: 3, lastPositiveAt: recent },
              trigrams: [],
              totalTrigramCount: 0,
            },
          ],
        },
        NOW
      ),
      4
    );
    assert.equal(
      scoreAdaptiveModerationEvidence(
        {
          exactOwnerConfirmed: false,
          families: [
            {
              token: { kind: "TOKEN", seenCount: 8, positiveCount: 8, lastPositiveAt: stale },
              trigrams: [],
              totalTrigramCount: 0,
            },
          ],
        },
        NOW
      ),
      0
    );
    assert.equal(scoreAdaptiveModerationEvidence({ exactOwnerConfirmed: true, families: [] }, NOW), 4);
  });

  it("does not stack correlated trigrams from one lexical family", () => {
    const learned = { kind: "TRIGRAM" as const, seenCount: 3, positiveCount: 3, lastPositiveAt: NOW.toISOString() };
    assert.equal(
      scoreAdaptiveModerationEvidence(
        {
          exactOwnerConfirmed: false,
          families: [
            {
              token: { kind: "TOKEN", seenCount: 3, positiveCount: 3, lastPositiveAt: NOW.toISOString() },
              trigrams: [learned, learned, learned, learned],
              totalTrigramCount: 4,
            },
          ],
        },
        NOW
      ),
      2
    );
    assert.equal(
      scoreAdaptiveModerationEvidence(
        {
          exactOwnerConfirmed: false,
          families: [
            { trigrams: [learned, learned, learned], totalTrigramCount: 3 },
            { trigrams: [learned, learned, learned], totalTrigramCount: 3 },
          ],
        },
        NOW
      ),
      3
    );
  });

  it("lets adaptive evidence classify uncertain text without overriding confident English", () => {
    const evidence = { exactOwnerConfirmed: true, families: [] } as const;
    assert.equal(classifyModerationLanguage("novelphrase alpha", [], evidence, NOW), "non_english");
    assert.equal(
      classifyModerationLanguage(
        "This is a complete English support message explaining the account issue and the requested next steps.",
        [],
        evidence,
        NOW
      ),
      "english"
    );
  });
});
