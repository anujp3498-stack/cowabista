import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BALANCED_SHARE,
  CONSERVATIVE_FLOOR,
  CONSERVATIVE_SHARE,
  effectiveCeiling,
  estimateDurationSeconds,
  parseDeliverySettings,
  presetRate,
  resolveCampaignDelivery,
  resolveDelivery,
} from "../src/services/campaign-delivery";
import { CAMPAIGN_PLATFORM_MAX_TPS } from "../src/services/campaign-pacing-coordinator";

// V2-06B delivery resolver (pure, no database). The one rate authority used
// by the Delivery step, the structured preflight and planning.

test("the platform ceiling is the pacing coordinator's CAMPAIGN_PLATFORM_MAX_TPS, and the effective ceiling is min(provider, platform)", () => {
  assert.equal(CAMPAIGN_PLATFORM_MAX_TPS, 1_000, "default platform maximum (no override in tests)");
  assert.equal(effectiveCeiling(80), 80);
  assert.equal(effectiveCeiling(2_000), CAMPAIGN_PLATFORM_MAX_TPS, "a provider rate above the platform maximum is capped by it");
  assert.equal(effectiveCeiling(500, 200), 200);
  for (const bad of [0, -1, 2.5, Number.NaN]) assert.equal(effectiveCeiling(bad), null, String(bad));
});

test("fastest safe = the effective ceiling", () => {
  for (const ceiling of [1, 3, 10, 80, 100, 1_000]) assert.equal(presetRate("fastest_safe", ceiling), ceiling);
  const resolution = resolveDelivery({ deliveryMode: "fastest_safe", senders: [{ phoneNumberId: 1, providerApprovedRate: 2_000 }, { phoneNumberId: 2, providerApprovedRate: 80 }] });
  assert.deepEqual(resolution.perSender.map((s) => [s.providerApprovedRate, s.platformRate, s.effectiveCeiling, s.plannedRate]), [[2_000, 1_000, 1_000, 1_000], [80, 1_000, 80, 80]]);
  assert.equal(resolution.totalMessagesPerSecond, 1_080);
});

test("balanced = floor(60% of the effective ceiling), at least 1, never above it", () => {
  assert.equal(BALANCED_SHARE, 0.6);
  assert.deepEqual([100, 80, 10, 3, 2, 1, 1_000].map((c) => presetRate("balanced", c)), [60, 48, 6, 1, 1, 1, 600]);
  for (let ceiling = 1; ceiling <= 1_000; ceiling++) {
    const rate = presetRate("balanced", ceiling);
    assert.ok(rate >= 1 && rate <= ceiling && rate === Math.max(1, Math.floor(ceiling * 0.6)), `ceiling ${ceiling} -> ${rate}`);
  }
});

test("conservative = min(ceiling, max(5, floor(25%))): the brief's examples and every ceiling 1..1000", () => {
  assert.equal(CONSERVATIVE_SHARE, 0.25);
  assert.equal(CONSERVATIVE_FLOOR, 5);
  assert.deepEqual([100, 80, 10, 3].map((c) => presetRate("conservative", c)), [25, 20, 5, 3]);
  assert.deepEqual([1, 5, 19, 20, 24, 1_000].map((c) => presetRate("conservative", c)), [1, 5, 5, 5, 6, 250]);
  for (let ceiling = 1; ceiling <= 1_000; ceiling++) {
    const rate = presetRate("conservative", ceiling);
    assert.ok(rate >= 1 && rate <= ceiling, `ceiling ${ceiling} -> ${rate}`);
  }
});

test("advanced: one whole rate per selected number, at most its ceiling, never clamped; other modes ignore saved advanced values", () => {
  const senders = [{ phoneNumberId: 1, providerApprovedRate: 80 }, { phoneNumberId: 2, providerApprovedRate: 20 }];
  const ok = resolveDelivery({ deliveryMode: "advanced", senders, settings: { perNumberRates: [{ phoneNumberId: 2, messagesPerSecond: 20 }, { phoneNumberId: 1, messagesPerSecond: 33 }] } });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.perSender.map((s) => s.plannedRate), [33, 20]);
  assert.equal(ok.totalMessagesPerSecond, 53);

  const codes = (settings: unknown) => resolveDelivery({ deliveryMode: "advanced", senders, settings }).problems.map((p) => `${p.code}:${p.phoneNumberId ?? "-"}`).sort();
  assert.deepEqual(codes({ perNumberRates: [{ phoneNumberId: 1, messagesPerSecond: 200 }, { phoneNumberId: 2, messagesPerSecond: 5 }] }), ["rate_above_ceiling:1"], "200 where the max is 80: refused, not clamped");
  const above = resolveDelivery({ deliveryMode: "advanced", senders, settings: { perNumberRates: [{ phoneNumberId: 1, messagesPerSecond: 200 }, { phoneNumberId: 2, messagesPerSecond: 5 }] } });
  assert.equal(above.problems[0]!.maxMessagesPerSecond, 80);
  assert.equal(above.perSender[0]!.plannedRate, null);
  assert.equal(above.totalMessagesPerSecond, null);
  assert.deepEqual(codes({ perNumberRates: [{ phoneNumberId: 1, messagesPerSecond: 10 }] }), ["advanced_rate_missing:2"]);
  assert.deepEqual(codes(undefined), ["advanced_rate_missing:1", "advanced_rate_missing:2"]);
  for (const bad of [0, -4, 2.5, "10", null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.ok(codes({ perNumberRates: [{ phoneNumberId: 1, messagesPerSecond: bad }, { phoneNumberId: 2, messagesPerSecond: 5 }] }).includes("advanced_rate_invalid:1"), `rate ${String(bad)}`);
  }
  assert.ok(codes({ perNumberRates: [{ phoneNumberId: 1, messagesPerSecond: 5 }, { phoneNumberId: 1, messagesPerSecond: 6 }, { phoneNumberId: 2, messagesPerSecond: 5 }] }).includes("advanced_rate_invalid:1"), "duplicate number");
  assert.ok(codes({ perNumberRates: [{ phoneNumberId: 1, messagesPerSecond: 5 }, { phoneNumberId: 2, messagesPerSecond: 5 }, { phoneNumberId: 99, messagesPerSecond: 5 }] }).includes("advanced_rate_invalid:99"), "a number that is not selected (e.g. another workspace's) is refused, never ignored");
  assert.ok(codes({ perNumberRates: [], speed: 9 }).includes("advanced_rate_invalid:-"), "unknown settings fields are refused");
  assert.ok(codes({ perNumberRates: [{ phoneNumberId: 1, messagesPerSecond: 5, burst: 9 }, { phoneNumberId: 2, messagesPerSecond: 5 }] }).includes("advanced_rate_invalid:1"), "unknown entry fields are refused");

  // A preset ignores stale advanced values entirely (even invalid ones).
  const preset = resolveDelivery({ deliveryMode: "balanced", senders, settings: { perNumberRates: [{ phoneNumberId: 1, messagesPerSecond: 999 }] } });
  assert.deepEqual(preset.problems, []);
  assert.deepEqual(preset.perSender.map((s) => s.plannedRate), [48, 12]);
});

test("tiny and unusable provider caps: rates stay within 1..ceiling; an unusable provider rate is a problem, not a guess", () => {
  for (const mode of ["fastest_safe", "balanced", "conservative"] as const) {
    const resolution = resolveDelivery({ deliveryMode: mode, senders: [{ phoneNumberId: 1, providerApprovedRate: 1 }, { phoneNumberId: 2, providerApprovedRate: 2 }] });
    assert.deepEqual(resolution.perSender.map((s) => s.plannedRate), [1, mode === "balanced" ? 1 : 2]);
  }
  const broken = resolveDelivery({ deliveryMode: "fastest_safe", senders: [{ phoneNumberId: 1, providerApprovedRate: 0 }] });
  assert.equal(broken.problems[0]!.code, "sender_rate_unavailable");
  assert.equal(broken.perSender[0]!.plannedRate, null);
  assert.equal(broken.totalMessagesPerSecond, null);
});

test("deterministic and order-independent; the estimate is ceil(recipients / rate)", () => {
  const a = resolveDelivery({ deliveryMode: "conservative", senders: [{ phoneNumberId: 2, providerApprovedRate: 40 }, { phoneNumberId: 1, providerApprovedRate: 100 }] });
  const b = resolveDelivery({ deliveryMode: "conservative", senders: [{ phoneNumberId: 1, providerApprovedRate: 100 }, { phoneNumberId: 2, providerApprovedRate: 40 }] });
  assert.deepEqual(a, b);
  const viaState = resolveCampaignDelivery({ phones: new Map([[1, { tpsLimit: 100 }], [2, { tpsLimit: 40 }]]) as never }, [2, 1, 3], "conservative", undefined);
  assert.deepEqual(viaState.perSender.map((s) => [s.phoneNumberId, s.plannedRate]), [[1, 25], [2, 10]], "numbers missing from the state are not invented");
  assert.equal(estimateDurationSeconds(1_000, 35), 29);
  assert.equal(estimateDurationSeconds(0, 35), 0);
  assert.equal(estimateDurationSeconds(1_000, null), null);
  assert.deepEqual(parseDeliverySettings(null), { settings: {}, problems: [] });
});
