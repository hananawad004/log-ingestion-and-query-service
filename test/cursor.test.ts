import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeCursor, decodeCursor } from "../src/utils/cursor.js";
import { InvalidCursorError } from "../src/domain/errors.js";

test("encodes and decodes a cursor round-trip", () => {
    const original = { ts: "2026-07-20T14:32:01.123Z", id: 42 };
    const encoded = encodeCursor(original);
    const decoded = decodeCursor(encoded);
    assert.deepEqual(decoded, original);
});

test("encoded cursor is url-safe (no +, /, or =)", () => {
    const encoded = encodeCursor({ ts: "2026-07-20T14:32:01.123Z", id: 999999 });
    assert.equal(/[+/=]/.test(encoded), false);
});

test("rejects garbage base64 that is not valid JSON", () => {
    assert.throws(() => decodeCursor("not-valid-base64!!!"), InvalidCursorError);
});

test("rejects valid base64 that is not JSON", () => {
    const notJson = Buffer.from("hello world", "utf-8").toString("base64url");
    assert.throws(() => decodeCursor(notJson), InvalidCursorError);
});

test("rejects JSON missing the id field", () => {
    const bad = Buffer.from(JSON.stringify({ ts: "2026-07-20T14:32:01.123Z" }), "utf-8").toString(
        "base64url",
    );
    assert.throws(() => decodeCursor(bad), InvalidCursorError);
});

test("rejects JSON with a non-numeric id", () => {
    const bad = Buffer.from(
        JSON.stringify({ ts: "2026-07-20T14:32:01.123Z", id: "42" }),
        "utf-8",
    ).toString("base64url");
    assert.throws(() => decodeCursor(bad), InvalidCursorError);
});

test("rejects JSON with an invalid timestamp string", () => {
    const bad = Buffer.from(JSON.stringify({ ts: "not-a-date", id: 42 }), "utf-8").toString(
        "base64url",
    );
    assert.throws(() => decodeCursor(bad), InvalidCursorError);
});