import * as Schema from "effect/Schema";

export class LinxStorageError extends Schema.TaggedError<LinxStorageError>()("LinxStorageError", {
  operation: Schema.Literals(["open", "query", "transaction", "migrate", "write", "read"]),
  entity: Schema.String,
  category: Schema.String,
}) {
  override get message(): string {
    return `Linx storage ${this.operation} failed for ${this.entity} (${this.category}).`;
  }
}

export class LinxIdempotencyConflictError extends Schema.TaggedError<LinxIdempotencyConflictError>()(
  "LinxIdempotencyConflictError",
  {
    idempotencyKey: Schema.String,
  },
) {
  override get message(): string {
    return `Linx request ${this.idempotencyKey} was already used with a different payload.`;
  }
}

export class LinxSnapshotConflictError extends Schema.TaggedError<LinxSnapshotConflictError>()(
  "LinxSnapshotConflictError",
  {
    expertId: Schema.String,
    revision: Schema.Number,
  },
) {
  override get message(): string {
    return `Expert ${this.expertId} revision ${this.revision} already has different snapshot content.`;
  }
}

export class LinxSnapshotIntegrityError extends Schema.TaggedError<LinxSnapshotIntegrityError>()(
  "LinxSnapshotIntegrityError",
  {
    snapshotId: Schema.String,
  },
) {
  override get message(): string {
    return `Snapshot ${this.snapshotId} content no longer matches its recorded hash.`;
  }
}

export class LinxResourcePathError extends Schema.TaggedError<LinxResourcePathError>()(
  "LinxResourcePathError",
  {
    operation: Schema.Literals(["put", "read"]),
    category: Schema.String,
  },
) {
  override get message(): string {
    return `Linx resource ${this.operation} rejected the path (${this.category}).`;
  }
}
