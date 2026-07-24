// src/vision/describe-image-tool.ts — fleet-defined describe_image for child sessions.
// Mirrors @getpipher/vision's describe_image contract so user muscle memory transfers,
// but execute() delegates via VisionPort (vision's extension never loads into the child).
import { Type, type Static } from "typebox";
import type { VisionPort } from "./port.ts";

const params = Type.Object({
  image: Type.String({ description: "Absolute path to the image file to analyze." }),
  prompt: Type.Optional(Type.String({ description: "Optional question/instruction for the analysis." })),
});
type DescribeImageInput = Static<typeof params>;

export function createDescribeImageTool(visionPort: VisionPort) {
  return {
    name: "describe_image",
    label: "Vision",
    description:
      "Analyze an image file and return a text description. Use when you read an image file and need to understand its contents. " +
      "Pass an absolute image path and an optional analysis prompt.",
    promptSnippet: "Analyze an image file and return a text description",
    promptGuidelines: [
      "Use describe_image when you read an image file (read returns an image attachment) and need a textual understanding of its contents.",
      "Pass the absolute image path; add an optional prompt to focus the analysis (e.g. 'describe the UI layout').",
    ],
    parameters: params,
    async execute(_toolCallId: string, p: DescribeImageInput, signal: AbortSignal, _onUpdate: unknown, _ctx: unknown) {
      const result = await visionPort.delegate({ imagePath: p.image, prompt: p.prompt }, signal);
      if (result.ok) {
        return { content: [{ type: "text" as const, text: result.text }] };
      }
      return { content: [{ type: "text" as const, text: result.error }], isError: true as const };
    },
  };
}