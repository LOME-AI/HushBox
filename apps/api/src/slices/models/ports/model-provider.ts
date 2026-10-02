import type { z } from 'zod';
import type {
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  ModelDescriptor,
} from '@hushbox/shared';
import type { ToolName } from '@hushbox/shared/affordability';

/** What a tool's execution receives beside its input: the run's cancellation. */
interface ToolExecuteOptions {
  readonly signal: AbortSignal;
}

/**
 * One tool the model may call during an agentic loop. Every tool is executed
 * client-side by the adapter's loop; adapters know tools by shape, never by
 * name, and callers inject the definitions per call.
 */
export interface ToolDefinition {
  readonly description: string;
  readonly inputSchema: z.ZodType;
  execute(input: unknown, options: ToolExecuteOptions): Promise<unknown>;
}

/**
 * The closed server registry: one definition per declared tool name, so a tool
 * whose facts the tool loop does not declare cannot be registered.
 */
export type ToolRegistry = Readonly<Record<ToolName, ToolDefinition>>;

/** The tools one call may use, keyed by the name the model calls each by. */
export type ToolSelection = Readonly<Record<string, ToolDefinition>>;

/**
 * Enables the SDK's multi-step tool loop inside the adapter. `maxSteps` is
 * the hard step ceiling (each step is its own gateway generation), and the
 * tool calls it allows, across every tool, are the loop's call budget.
 */
export interface ToolLoopOptions {
  readonly registry: ToolSelection;
  readonly maxSteps: number;
}

export interface InferOptions {
  /** Cooperative cancel — wired through the SDK to abort the gateway fetch. */
  readonly signal?: AbortSignal;
  readonly tools?: ToolLoopOptions;
  /**
   * Maps multi-output `file` parts (a text+image model streaming through the
   * language call-shape) to media-start/media-done events. Where the bytes
   * rest is the caller's decision (the engine's ValueStore seam), never the
   * adapter's. Required whenever the model can emit file parts.
   */
  readonly mapFilePart?: FilePartMapper;
  /**
   * Upper bound (bytes) on a downloaded media artifact — the slice of the run's
   * ValueStore budget reserved for this call, threaded from the engine as a
   * plain value so a large video aborts mid-download before the whole blob
   * materializes in the isolate. Enforced only on the video download (the one
   * path that materializes a full artifact outside the SDK). Absent leaves the
   * download bounded solely by the provider/SDK default.
   */
  readonly downloadByteCap?: number;
}

/**
 * The modality-agnostic inference port. One adapter per SDK call-shape
 * family implements it; dispatch by output family lives with the catalog.
 * Expected failures travel as thrown `InferenceError`s — the stream has no
 * error event variant.
 */
export interface ModelProvider {
  infer(
    request: InferenceRequest,
    descriptor: ModelDescriptor,
    options?: InferOptions
  ): AsyncIterable<InferenceEvent>;
}
