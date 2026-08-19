export class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ValidationError";
    }
}

export class InvalidCursorError extends Error {
    constructor(message = "invalid cursor") {
        super(message);
        this.name = "InvalidCursorError";
    }
}