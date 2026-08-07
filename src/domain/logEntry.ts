export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type AttributeValue = string | number | boolean;

export type Attributes = Record<string, AttributeValue>;

export interface LogEntry {
    id: string;
    timestamp: string;
    level: LogLevel;
    service: string;
    message: string;
    attributes: Attributes;
}

export interface RawLogEntry {
    timestamp?: unknown;
    level?: unknown;
    service?: unknown;
    message?: unknown;
    attributes?: unknown;
}