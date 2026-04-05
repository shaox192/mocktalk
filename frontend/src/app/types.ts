import type { AICoachModelId, TranscriberModelId } from "./models";

export type AICoachModel = AICoachModelId | "none";
export type TranscriberModel = TranscriberModelId | "local" | "none";

export interface MockTalkSettings {
  aiCoachModel: AICoachModel;
  aiCoachApiKey: string;
  transcriberModel: TranscriberModel;
  transcriberApiKey: string;
  language: string;
  presentationDescription: string;
  slideChangeSensitivity: number; // 1-10
  interruptionFrequency: number; // 1-10
  fakeSession: boolean;
}

export const DEFAULT_SETTINGS: MockTalkSettings = {
  aiCoachModel: "none",
  aiCoachApiKey: "",
  transcriberModel: "none",
  transcriberApiKey: "",
  language: "en",
  presentationDescription: "",
  slideChangeSensitivity: 5,
  interruptionFrequency: 5,
  fakeSession: false,
};
