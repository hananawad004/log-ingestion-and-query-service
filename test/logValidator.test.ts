import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLogEntry } from "../src/validation/logValidator.js";

test("accepts a fully valid log entry", () => {
    const result = validateLogEntry({
        timestamp: "2026-07-20T14:32:01.123Z",
        level: "error",
        service: "checkout",
        message: "payment declined",
        attributes: { user_id: "42", retries: 3, flagged: true },
    });
    assert.equal(result.valid, true);
});

test("rejects entry missing timestamp", () => {
    const result = validateLogEntry({
        level: "error",
        service: "checkout",
        message: "payment declined",
    });
    assert.equal(result.valid, false);
});

test("rejects invalid timestamp format", () => {
    const result = validateLogEntry({
        timestamp: "not-a-date",
        level: "error",
        service: "checkout",
        message: "payment declined",
    });
    assert.equal(result.valid, false);
});

test("rejects timestamp more than 5 minutes in the future", () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const result = validateLogEntry({
        timestamp: future,
        level: "error",
        service: "checkout",
        message: "payment declined",
    });
    assert.equal(result.valid, false);
});

test("accepts timestamp exactly at the 5 minute boundary", () => {
    const future = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    const result = validateLogEntry({
        timestamp: future,
        level: "info",
        service: "checkout",
        message: "ok",
    });
    assert.equal(result.valid, true);
});

test("rejects invalid level", () => {
    const result = validateLogEntry({
        timestamp: new Date().toISOString(),
        level: "critical",
        service: "checkout",
        message: "payment declined",
    });
    assert.equal(result.valid, false);
});

test("rejects empty service string", () => {
    const result = validateLogEntry({
        timestamp: new Date().toISOString(),
        level: "info",
        service: "",
        message: "hello",
    });
    assert.equal(result.valid, false);
});

test("rejects empty message string", () => {
    const result = validateLogEntry({
        timestamp: new Date().toISOString(),
        level: "info",
        service: "checkout",
        message: "",
    });
    assert.equal(result.valid, false);
});

test("accepts missing attributes (optional field)", () => {
    const result = validateLogEntry({
        timestamp: new Date().toISOString(),
        level: "info",
        service: "checkout",
        message: "hello",
    });
    assert.equal(result.valid, true);
});

test("rejects nested object inside attributes", () => {
    const result = validateLogEntry({
        timestamp: new Date().toISOString(),
        level: "info",
        service: "checkout",
        message: "hello",
        attributes: { user: { id: 42 } },
    });
    assert.equal(result.valid, false);
});

test("rejects array inside attributes", () => {
    const result = validateLogEntry({
        timestamp: new Date().toISOString(),
        level: "info",
        service: "checkout",
        message: "hello",
        attributes: { tags: ["a", "b"] },
    });
    assert.equal(result.valid, false);
});

test("rejects null value inside attributes", () => {
    const result = validateLogEntry({
        timestamp: new Date().toISOString(),
        level: "info",
        service: "checkout",
        message: "hello",
        attributes: { region: null },
    });
    assert.equal(result.valid, false);
});

test("rejects entry that is not an object", () => {
    const result = validateLogEntry("not an object");
    assert.equal(result.valid, false);
});

test("rejects entry that is an array", () => {
    const result = validateLogEntry(["a", "b"]);
    assert.equal(result.valid, false);
});