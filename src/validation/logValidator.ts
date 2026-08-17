import { LOG_LEVELS, type Attributes, type AttributeValue, type LogLevel } from "../domain/logEntry.js";

export interface ValidatedLogEntry {
    timestamp: string;
    level: LogLevel;
    service: string;
    message: string;
    attributes: Attributes;
}

export type ValidationResult =
    | { valid: true; entry: ValidatedLogEntry }
    | { valid: false; reason: string };

const FIVE_MINUTES_MS = 5 * 60 * 1000;

export function validateLogEntry(raw: unknown): ValidationResult {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { valid: false, reason: "log entry must be an object" };
    }

    const entry = raw as Record<string, unknown>;

    const timestampResult = validateTimestamp(entry.timestamp);
    if (!timestampResult.valid) return timestampResult;

    const levelResult = validateLevel(entry.level);
    if (!levelResult.valid) return levelResult;

    const serviceResult = validateNonEmptyString(entry.service, "service");
    if (!serviceResult.valid) return serviceResult;

    const messageResult = validateNonEmptyString(entry.message, "message");
    if (!messageResult.valid) return messageResult;

    const attributesResult = validateAttributes(entry.attributes);
    if (!attributesResult.valid) return attributesResult;

    return {
        valid: true,
        entry: {
            timestamp: timestampResult.value,
            level: levelResult.value,
            service: serviceResult.value,
            message: messageResult.value,
            attributes: attributesResult.value,
        },
    };
}

function validateTimestamp(value: unknown): { valid: true; value: string } | { valid: false; reason: string } {
    if (typeof value !== "string" || value.trim() === "") {
        return { valid: false, reason: "timestamp is required and must be a string" };
    }

    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
        return { valid: false, reason: `invalid timestamp: '${value}'` };
    }

    if (parsed - Date.now() > FIVE_MINUTES_MS) {
        return { valid: false, reason: "timestamp must not be more than five minutes in the future" };
    }

    return { valid: true, value: new Date(parsed).toISOString() };
}

function validateLevel(value: unknown): { valid: true; value: LogLevel } | { valid: false; reason: string } {
    if (typeof value !== "string") {
        return { valid: false, reason: "level is required" };
    }
    if (!(LOG_LEVELS as readonly string[]).includes(value)) {
        return { valid: false, reason: `invalid level: '${value}'` };
    }
    return { valid: true, value: value as LogLevel };
}

function validateNonEmptyString(
    value: unknown,
    field: string,
): { valid: true; value: string } | { valid: false; reason: string } {
    if (typeof value !== "string" || value.trim() === "") {
        return { valid: false, reason: `${field} is required and must be a non-empty string` };
    }
    return { valid: true, value };
}

function validateAttributes(
    value: unknown,
): { valid: true; value: Attributes } | { valid: false; reason: string } {
    if (value === undefined) {
        return { valid: true, value: {} };
    }

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { valid: false, reason: "attributes must be a flat object" };
    }

    const result: Attributes = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (!isAttributeValue(val)) {
            return { valid: false, reason: `attribute '${key}' must be a string, number, or boolean` };
        }
        result[key] = String(val);
    }

    return { valid: true, value: result };
}

function isAttributeValue(value: unknown): value is AttributeValue {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}