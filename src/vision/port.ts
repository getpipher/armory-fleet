// src/vision/port.ts — fleet-owned port; fleet core depends only on this.
import type { Model } from "@earendil-works/pi-ai";

export interface VisionDelegateParams {
  /** Absolute path to the image file the child read. */
  imagePath: string;
  /** Optional analysis prompt. */
  prompt?: string;
}
export type VisionDelegateResult = { ok: true; text: string } | { ok: false; error: string };

export interface VisionPort {
  /** Whether the given model can process images natively (pass-through) vs needs delegation. */
  isMultimodal(model: Model<any> | undefined): boolean;
  /** Delegate image analysis to the configured vision model; returns text or an actionable error. */
  delegate(params: VisionDelegateParams, signal?: AbortSignal): Promise<VisionDelegateResult>;
  /** Whether a vision model is configured in the host vision.json. */
  isConfigured(): boolean;
}