import { describe, expect, it } from "vitest";
import { decide, inAllotmentWindow, istParts, MAX_AUTO_ERROR_RETRIES, type IpoState } from "../src/services/scheduler.js";

const NOW = new Date("2026-10-28T06:30:00Z"); // 12:00 IST
const min = (m: number) => new Date(NOW.getTime() - m * 60_000);
const state = (o: Partial<IpoState>): IpoState => ({
  activeJob: false, unchecked: 0, found: 5, errors: 0, lastAutoJob: null, autoErrorRetries: 0, lastProbeAt: null, ...o,
});

describe("istParts / window", () => {
  it("uses India time", () => {
    expect(istParts(new Date("2026-10-27T19:00:00Z"))).toEqual({ date: "2026-10-28", hour: 0 }); // 00:30 IST next day
    expect(istParts(NOW)).toEqual({ date: "2026-10-28", hour: 12 });
  });

  it("covers allotment day and the day after", () => {
    const d = (s: string) => new Date(`${s}T00:00:00Z`);
    expect(inAllotmentWindow(d("2026-10-28"), "2026-10-28")).toBe(true);
    expect(inAllotmentWindow(d("2026-10-27"), "2026-10-28")).toBe(true);
    expect(inAllotmentWindow(d("2026-10-26"), "2026-10-28")).toBe(false);
    expect(inAllotmentWindow(d("2026-10-29"), "2026-10-28")).toBe(false);
    expect(inAllotmentWindow(null, "2026-10-28")).toBe(false);
  });
});

describe("decide", () => {
  it("waits while a job runs", () => {
    expect(decide(state({ activeJob: true, unchecked: 100 }), NOW).action).toBe("wait");
  });

  it("checks unchecked PANs first", () => {
    expect(decide(state({ unchecked: 12 }), NOW)).toMatchObject({ action: "job", scope: "unchecked" });
  });

  it("probes when nothing has been found, at most every 30 minutes", () => {
    expect(decide(state({ found: 0 }), NOW).action).toBe("probe");
    expect(decide(state({ found: 0, lastProbeAt: min(10) }), NOW).action).toBe("wait");
    expect(decide(state({ found: 0, lastProbeAt: min(31) }), NOW).action).toBe("probe");
  });

  it("retries errors with a gap and a cap", () => {
    expect(decide(state({ errors: 3 }), NOW)).toMatchObject({ action: "job", scope: "failed" });
    expect(decide(state({ errors: 3, lastAutoJob: { createdAt: min(20), finishedAt: min(5) } }), NOW).action).toBe("wait");
    expect(decide(state({ errors: 3, lastAutoJob: { createdAt: min(40), finishedAt: min(20) } }), NOW)).toMatchObject({ action: "job", scope: "failed" });
    expect(decide(state({ errors: 3, autoErrorRetries: MAX_AUTO_ERROR_RETRIES }), NOW)).toMatchObject({ action: "wait", reason: expect.stringMatching(/errors left/) });
  });

  it("is done when everything is found and error-free", () => {
    expect(decide(state({}), NOW)).toEqual({ action: "wait", reason: "Done" });
  });
});
