// src/vision/adapter.ts — ONLY file importing @getpipher/vision.
import {
  isMultimodal,
  createVisionDelegator,
  type VisionConfig,
  type DelegateResult,
  type ModelRegistryLike,
} from "@getpipher/vision";
import type { Model } from "@earendil-works/pi-ai";
import type { VisionPort, VisionDelegateParams, VisionDelegateResult } from "./port.ts";

export interface ArmoryVisionAdapterDeps {
  /** A ModelRegistry (or the { find, getApiKeyAndHeaders } slice). Fleet constructs new ModelRegistry(modelRuntime). */
  modelRegistry: ModelRegistryLike;
  /** The cwd for image path resolution. */
  cwd: string;
  /** The pi agent dir (where vision.json lives). */
  agentDir: string;
}

export class ArmoryVisionAdapter implements VisionPort {
  private readonly delegator: ReturnType<typeof createVisionDelegator>;
  constructor(deps: ArmoryVisionAdapterDeps) {
    this.delegator = createVisionDelegator({ modelRegistry: deps.modelRegistry, cwd: deps.cwd, agentDir: deps.agentDir });
  }
  isMultimodal(model: Model<any> | undefined): boolean {
    return isMultimodal(model);
  }
  isConfigured(): boolean {
    const c = this.delegator.config as VisionConfig;
    return Boolean(c.enabled && c.provider && c.model);
  }
  async delegate(params: VisionDelegateParams, signal?: AbortSignal): Promise<VisionDelegateResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        error: "no vision model configured; run `/vision model <id>` in the host or set `vision: false` on this agent.",
      };
    }
    const result: DelegateResult = await this.delegator.delegate(
      {
        image_path: params.imagePath,
        prompt: params.prompt ?? "",
        compress: true,
        reasoning: this.delegator.config.defaultReasoningEffort ?? "off",
      },
      signal,
    );
    return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.error.message };
  }
}