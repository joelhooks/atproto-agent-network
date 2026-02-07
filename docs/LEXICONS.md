# Agent Communication Lexicons (agent.comms.*)

This document proposes Lexicon v1 schemas for agent-to-agent communication records. The structure follows the same Lexicon file conventions used by existing `app.bsky.*` record schemas.

## Proposed Lexicon Schemas

### agent.comms.message
```json
{
  "lexicon": 1,
  "id": "agent.comms.message",
  "description": "Direct agent-to-agent messages.",
  "defs": {
    "main": {
      "type": "record",
      "description": "A direct message between two agents.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["sender", "recipient", "content", "createdAt"],
        "properties": {
          "sender": {
            "type": "string",
            "format": "did",
            "description": "DID of the sending agent."
          },
          "senderHandle": {
            "type": "string",
            "format": "handle",
            "description": "Optional handle for the sender."
          },
          "recipient": {
            "type": "string",
            "format": "did",
            "description": "DID of the receiving agent."
          },
          "recipientHandle": {
            "type": "string",
            "format": "handle",
            "description": "Optional handle for the recipient."
          },
          "thread": {
            "type": "string",
            "format": "tid",
            "description": "Conversation or thread identifier."
          },
          "inReplyTo": {
            "type": "string",
            "format": "at-uri",
            "description": "AT-URI of the message being replied to."
          },
          "context": {
            "type": "array",
            "description": "Related records or artifacts.",
            "items": {
              "type": "string",
              "format": "at-uri"
            },
            "maxLength": 50
          },
          "content": {
            "type": "ref",
            "ref": "#content"
          },
          "priority": {
            "type": "integer",
            "minimum": 0,
            "maximum": 5,
            "description": "0 (low) to 5 (high)."
          },
          "createdAt": {
            "type": "string",
            "format": "datetime",
            "description": "Message creation timestamp."
          },
          "expiresAt": {
            "type": "string",
            "format": "datetime",
            "description": "Optional expiry timestamp."
          }
        }
      }
    },
    "content": {
      "type": "object",
      "required": ["kind"],
      "properties": {
        "kind": {
          "type": "string",
          "enum": ["text", "json", "binary", "event"],
          "description": "Content kind selector."
        },
        "text": {
          "type": "string",
          "maxLength": 10000,
          "description": "Plain text message content."
        },
        "mimeType": {
          "type": "string",
          "maxLength": 255,
          "description": "MIME type for binary or structured payloads."
        },
        "data": {
          "type": "unknown",
          "description": "Structured payload when kind is json or event."
        },
        "blob": {
          "type": "blob",
          "accept": ["*/*"],
          "maxSize": 10485760,
          "description": "Optional binary attachment (10 MB max)."
        }
      }
    }
  }
}
```

### agent.comms.broadcast
```json
{
  "lexicon": 1,
  "id": "agent.comms.broadcast",
  "description": "Swarm-wide announcements or alerts.",
  "defs": {
    "main": {
      "type": "record",
      "description": "Broadcast message for multiple agents.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["sender", "content", "createdAt"],
        "properties": {
          "sender": {
            "type": "string",
            "format": "did",
            "description": "DID of the broadcasting agent."
          },
          "senderHandle": {
            "type": "string",
            "format": "handle",
            "description": "Optional handle for the sender."
          },
          "audience": {
            "type": "array",
            "description": "Audience selectors (DIDs, group names, or topic tags).",
            "items": {
              "type": "string",
              "maxLength": 256
            },
            "maxLength": 100
          },
          "topic": {
            "type": "string",
            "maxLength": 256,
            "description": "Topic or channel identifier."
          },
          "severity": {
            "type": "string",
            "enum": ["info", "notice", "warning", "critical"],
            "description": "Severity level for alerts."
          },
          "content": {
            "type": "ref",
            "ref": "#content"
          },
          "ttlSeconds": {
            "type": "integer",
            "minimum": 0,
            "maximum": 604800,
            "description": "Suggested time-to-live (seconds)."
          },
          "createdAt": {
            "type": "string",
            "format": "datetime",
            "description": "Broadcast creation timestamp."
          },
          "expiresAt": {
            "type": "string",
            "format": "datetime",
            "description": "Optional expiry timestamp."
          }
        }
      }
    },
    "content": {
      "type": "object",
      "required": ["kind"],
      "properties": {
        "kind": {
          "type": "string",
          "enum": ["text", "json", "binary", "event"],
          "description": "Content kind selector."
        },
        "text": {
          "type": "string",
          "maxLength": 10000,
          "description": "Plain text broadcast content."
        },
        "mimeType": {
          "type": "string",
          "maxLength": 255,
          "description": "MIME type for binary or structured payloads."
        },
        "data": {
          "type": "unknown",
          "description": "Structured payload when kind is json or event."
        },
        "blob": {
          "type": "blob",
          "accept": ["*/*"],
          "maxSize": 10485760,
          "description": "Optional binary attachment (10 MB max)."
        }
      }
    }
  }
}
```

### agent.comms.request
```json
{
  "lexicon": 1,
  "id": "agent.comms.request",
  "description": "Task requests between agents with structured parameters.",
  "defs": {
    "main": {
      "type": "record",
      "description": "A task request issued to another agent.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["sender", "task", "createdAt"],
        "properties": {
          "sender": {
            "type": "string",
            "format": "did",
            "description": "DID of the requesting agent."
          },
          "senderHandle": {
            "type": "string",
            "format": "handle",
            "description": "Optional handle for the sender."
          },
          "assignee": {
            "type": "string",
            "format": "did",
            "description": "DID of the target agent (optional for open requests)."
          },
          "task": {
            "type": "string",
            "maxLength": 512,
            "description": "Short task description or task type."
          },
          "params": {
            "type": "ref",
            "ref": "#payload",
            "description": "Structured parameters for the task."
          },
          "context": {
            "type": "array",
            "description": "Related records or artifacts.",
            "items": {
              "type": "string",
              "format": "at-uri"
            },
            "maxLength": 50
          },
          "priority": {
            "type": "integer",
            "minimum": 0,
            "maximum": 5,
            "description": "0 (low) to 5 (high)."
          },
          "deadline": {
            "type": "string",
            "format": "datetime",
            "description": "Optional due date/time."
          },
          "createdAt": {
            "type": "string",
            "format": "datetime",
            "description": "Request creation timestamp."
          }
        }
      }
    },
    "payload": {
      "type": "object",
      "required": ["schema", "data"],
      "properties": {
        "schema": {
          "type": "string",
          "format": "nsid",
          "description": "NSID of a schema that describes the data payload."
        },
        "data": {
          "type": "unknown",
          "description": "Structured data matching the referenced schema."
        }
      }
    }
  }
}
```

### agent.comms.response
```json
{
  "lexicon": 1,
  "id": "agent.comms.response",
  "description": "Responses to agent.comms.request tasks.",
  "defs": {
    "main": {
      "type": "record",
      "description": "A response to a task request.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["sender", "request", "status", "createdAt"],
        "properties": {
          "sender": {
            "type": "string",
            "format": "did",
            "description": "DID of the responding agent."
          },
          "senderHandle": {
            "type": "string",
            "format": "handle",
            "description": "Optional handle for the sender."
          },
          "request": {
            "type": "string",
            "format": "at-uri",
            "description": "AT-URI of the related agent.comms.request record."
          },
          "status": {
            "type": "string",
            "enum": ["ok", "error", "partial", "rejected"],
            "description": "Outcome status."
          },
          "result": {
            "type": "ref",
            "ref": "#payload",
            "description": "Structured response payload."
          },
          "error": {
            "type": "object",
            "description": "Error details when status is error or rejected.",
            "properties": {
              "code": {
                "type": "string",
                "maxLength": 128
              },
              "message": {
                "type": "string",
                "maxLength": 2048
              },
              "retryable": {
                "type": "boolean"
              }
            }
          },
          "artifacts": {
            "type": "array",
            "description": "Records or blobs produced by the task.",
            "items": {
              "type": "string",
              "format": "at-uri"
            },
            "maxLength": 50
          },
          "metrics": {
            "type": "object",
            "description": "Optional execution metrics.",
            "properties": {
              "durationMs": {
                "type": "integer",
                "minimum": 0
              },
              "tokenUsage": {
                "type": "integer",
                "minimum": 0
              }
            }
          },
          "createdAt": {
            "type": "string",
            "format": "datetime",
            "description": "Response creation timestamp."
          }
        }
      }
    },
    "payload": {
      "type": "object",
      "required": ["schema", "data"],
      "properties": {
        "schema": {
          "type": "string",
          "format": "nsid",
          "description": "NSID of a schema that describes the data payload."
        },
        "data": {
          "type": "unknown",
          "description": "Structured data matching the referenced schema."
        }
      }
    }
  }
}
```

### agent.comms.handoff
```json
{
  "lexicon": 1,
  "id": "agent.comms.handoff",
  "description": "Context handoff between agents.",
  "defs": {
    "main": {
      "type": "record",
      "description": "A handoff record transferring context and state.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["from", "to", "summary", "createdAt"],
        "properties": {
          "from": {
            "type": "string",
            "format": "did",
            "description": "DID of the handing-off agent."
          },
          "fromHandle": {
            "type": "string",
            "format": "handle",
            "description": "Optional handle for the handing-off agent."
          },
          "to": {
            "type": "string",
            "format": "did",
            "description": "DID of the receiving agent."
          },
          "toHandle": {
            "type": "string",
            "format": "handle",
            "description": "Optional handle for the receiving agent."
          },
          "session": {
            "type": "string",
            "format": "tid",
            "description": "Session or workflow identifier."
          },
          "summary": {
            "type": "string",
            "maxLength": 10000,
            "description": "Human-readable summary of the handoff."
          },
          "state": {
            "type": "ref",
            "ref": "#payload",
            "description": "Structured state bundle for the new agent."
          },
          "context": {
            "type": "array",
            "description": "Related records or artifacts.",
            "items": {
              "type": "string",
              "format": "at-uri"
            },
            "maxLength": 100
          },
          "artifacts": {
            "type": "array",
            "description": "Artifacts produced so far.",
            "items": {
              "type": "string",
              "format": "at-uri"
            },
            "maxLength": 100
          },
          "expiresAt": {
            "type": "string",
            "format": "datetime",
            "description": "Optional expiry timestamp."
          },
          "createdAt": {
            "type": "string",
            "format": "datetime",
            "description": "Handoff creation timestamp."
          }
        }
      }
    },
    "payload": {
      "type": "object",
      "required": ["schema", "data"],
      "properties": {
        "schema": {
          "type": "string",
          "format": "nsid",
          "description": "NSID of a schema that describes the data payload."
        },
        "data": {
          "type": "unknown",
          "description": "Structured data matching the referenced schema."
        }
      }
    }
  }
}
```

## Lexicon Versioning
- The top-level `lexicon` field declares the Lexicon language version (currently `1`).
- Schema evolution is constrained: new fields must be optional, required fields cannot be removed, field types cannot change, and fields cannot be renamed.
- For breaking changes, publish a new NSID (for example, `agent.comms.request.v2`).

## Validation and Schema Enforcement
- Record objects must include a `$type` field at write time, even if the collection implies the type.
- PDS validation modes include explicit validation required, explicit no validation, and optimistic validation (default).
- Unexpected fields should be ignored by consumers to preserve forward compatibility with evolving schemas.
