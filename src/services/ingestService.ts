import { validateLogEntry } from "../validation/logValidator.js";
import { insertBatch } from "../repositories/logRepository.js";
import type { ValidatedLogEntry } from "../validation/logValidator.js";

export interface RejectedEntry {
    index: number;
    reason: string;
}

export interface IngestResult {
    accepted: number;
    rejected: RejectedEntry[];
}

export async function ingestLogs(rawEntries: unknown[]): Promise<IngestResult> {
    const validEntries: ValidatedLogEntry[] = [];
    const rejected: RejectedEntry[] = [];

    rawEntries.forEach((raw, index) => {
        const result = validateLogEntry(raw);
        if (result.valid) {
            validEntries.push(result.entry);
        } else {
            rejected.push({ index, reason: result.reason });
        }
    });

    const accepted = await insertBatch(validEntries);

    return { accepted, rejected };
}