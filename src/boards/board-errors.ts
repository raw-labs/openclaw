type BoardValidationErrorCode = "conflict" | "invalid_operation" | "not_found";

export class BoardValidationError extends Error {
  readonly code: BoardValidationErrorCode;

  constructor(code: BoardValidationErrorCode, message: string) {
    super(message);
    this.name = "BoardValidationError";
    this.code = code;
  }
}

export class BoardGatewayUnavailableError extends Error {
  constructor() {
    super("dashboard unavailable");
    this.name = "BoardGatewayUnavailableError";
  }
}
