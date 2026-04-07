import * as errore from "errore";

export class ValidationError extends errore.createTaggedError({
  name: "ValidationError",
  message: "Invalid $field: $reason",
}) {}

export class DirectoryCreateError extends errore.createTaggedError({
  name: "DirectoryCreateError",
  message: "Failed to create ContextTemple directory at $path",
}) {}

export class DatabaseOpenError extends errore.createTaggedError({
  name: "DatabaseOpenError",
  message: "Failed to open ContextTemple database at $path",
}) {}

export class DatabaseBootstrapError extends errore.createTaggedError({
  name: "DatabaseBootstrapError",
  message: "Failed to bootstrap ContextTemple database at $path",
}) {}

export class DatabaseQueryError extends errore.createTaggedError({
  name: "DatabaseQueryError",
  message: "Database operation failed during $operation",
}) {}

export class JsonParsingError extends errore.createTaggedError({
  name: "JsonParsingError",
  message: "Failed to parse stored JSON for $context",
}) {}

export class JsonEncodingError extends errore.createTaggedError({
  name: "JsonEncodingError",
  message: "Failed to encode JSON for $context",
}) {}

export class ServerStartError extends errore.createTaggedError({
  name: "ServerStartError",
  message: "Failed to start ContextTemple server on port $port",
}) {}
