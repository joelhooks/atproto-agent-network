/**
 * Lexicon schemas (Zod)
 * 
 * AT Protocol-inspired typed message contracts
 */

import { z } from 'zod'

// Memory records
export const MemoryNote = z.object({
  $type: z.literal('agent.memory.note'),
  summary: z.string(),
  text: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source: z.string().optional(),
  createdAt: z.string().datetime(),
}).passthrough()

export const MemoryDecision = z.object({
  $type: z.literal('agent.memory.decision'),
  decision: z.string(),
  context: z.string(),
  options: z.array(z.string()).optional(),
  rationale: z.string(),
  status: z.enum(['proposed', 'accepted', 'rejected', 'superseded']),
  createdAt: z.string().datetime(),
}).passthrough()

// Communication
export const Message = z.object({
  $type: z.literal('agent.comms.message'),
  sender: z.string(),
  recipient: z.string(),
  thread: z.string().optional(),
  content: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), text: z.string() }).passthrough(),
    z.object({ kind: z.literal('json'), data: z.unknown() }).passthrough(),
    z.object({ kind: z.literal('ref'), uri: z.string() }).passthrough(),
  ]),
  priority: z.number().int().min(1).max(5).default(3),
  createdAt: z.string().datetime(),
}).passthrough()

export const TaskRequest = z.object({
  $type: z.literal('agent.comms.task'),
  sender: z.string(),
  recipient: z.string(),
  task: z.string(),
  params: z.record(z.unknown()).optional(),
  deadline: z.string().datetime().optional(),
  replyTo: z.string(),
  resultVisibility: z.enum(['private', 'shared', 'public']).default('private'),
  createdAt: z.string().datetime(),
}).passthrough()

export const TaskResponse = z.object({
  $type: z.literal('agent.comms.response'),
  sender: z.string(),
  recipient: z.string(),
  requestUri: z.string(),
  status: z.enum(['accepted', 'completed', 'failed', 'rejected']),
  result: z.unknown().optional(),
  error: z.string().optional(),
  createdAt: z.string().datetime(),
}).passthrough()

export const Handoff = z.object({
  $type: z.literal('agent.comms.handoff'),
  from: z.string(),
  to: z.string(),
  context: z.array(z.object({
    recordId: z.string(),
    encryptedDek: z.string(),
  }).passthrough()),
  reason: z.string(),
  createdAt: z.string().datetime(),
}).passthrough()

export const LexiconRecordSchema = z.discriminatedUnion('$type', [
  MemoryNote,
  MemoryDecision,
  Message,
  TaskRequest,
  TaskResponse,
  Handoff,
])

// Export types
export type MemoryNote = z.infer<typeof MemoryNote>
export type MemoryDecision = z.infer<typeof MemoryDecision>
export type Message = z.infer<typeof Message>
export type TaskRequest = z.infer<typeof TaskRequest>
export type TaskResponse = z.infer<typeof TaskResponse>
export type Handoff = z.infer<typeof Handoff>
export type LexiconRecord = z.infer<typeof LexiconRecordSchema>
