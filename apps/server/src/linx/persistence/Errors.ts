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

export class LinxRevisionConflictError extends Schema.TaggedError<LinxRevisionConflictError>()(
  "LinxRevisionConflictError",
  {
    entity: Schema.String,
    expectedRevision: Schema.Number,
    actualRevision: Schema.Number,
  },
) {
  override get message(): string {
    return `Linx ${this.entity} is at revision ${this.actualRevision}, not ${this.expectedRevision}.`;
  }
}

export class LinxDefinitionMissingError extends Schema.TaggedError<LinxDefinitionMissingError>()(
  "LinxDefinitionMissingError",
  {
    entity: Schema.String,
    id: Schema.String,
  },
) {
  override get message(): string {
    return `Linx ${this.entity} ${this.id} does not exist.`;
  }
}

export class LinxDefinitionArchivedError extends Schema.TaggedError<LinxDefinitionArchivedError>()(
  "LinxDefinitionArchivedError",
  {
    entity: Schema.String,
    id: Schema.String,
  },
) {
  override get message(): string {
    return `Linx ${this.entity} ${this.id} is archived.`;
  }
}

export class LinxDependencyMissingError extends Schema.TaggedError<LinxDependencyMissingError>()(
  "LinxDependencyMissingError",
  {
    entity: Schema.String,
    id: Schema.String,
    category: Schema.String,
  },
) {
  override get message(): string {
    return `Linx ${this.entity} ${this.id} cannot be resolved (${this.category}).`;
  }
}

export class LinxLimitExceededError extends Schema.TaggedError<LinxLimitExceededError>()(
  "LinxLimitExceededError",
  {
    limit: Schema.String,
    actual: Schema.Number,
    maximum: Schema.Number,
  },
) {
  override get message(): string {
    return `Linx rejected the skill package: ${this.limit} is ${this.actual}, above ${this.maximum}.`;
  }
}

export class LinxMcpTransportError extends Schema.TaggedError<LinxMcpTransportError>()(
  "LinxMcpTransportError",
  {
    endpoint: Schema.String,
    category: Schema.String,
  },
) {
  override get message(): string {
    return `The external MCP endpoint could not be used (${this.category}).`;
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
