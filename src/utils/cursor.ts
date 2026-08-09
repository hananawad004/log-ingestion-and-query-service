import { InvalidCursorError } from "../domain/errors.js";

export interface Cursor {
    ts: string;
    id: number;
}

export function encodeCursor(cursor: Cursor): string {
    const json = JSON.stringify(cursor);
    return Buffer.from(json, "utf-8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor {
    let json: string;
    try {
        json = Buffer.from(raw, "base64url").toString("utf-8");
    } catch {
        throw new InvalidCursorError();
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new InvalidCursorError();
    }

    if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as Record<string, unknown>).ts !== "string" ||
        typeof (parsed as Record<string, unknown>).id !== "number"
    ) {
        throw new InvalidCursorError();
    }

    const { ts, id } = parsed as Cursor;

    if (Number.isNaN(Date.parse(ts))) {
        throw new InvalidCursorError();
    }

    return { ts, id };
}