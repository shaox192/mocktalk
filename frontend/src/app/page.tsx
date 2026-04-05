"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSettings } from "./SettingsContext";
import { DEFAULT_SETTINGS } from "./types";
import type { AICoachModel, TranscriberModel } from "./types";
import {
  AI_COACH_MODELS,
  TRANSCRIBER_MODELS,
  getCoachProvider,
  getTranscriberProvider,
  getTranscriberModelId,
  getKeyPlaceholder,
  transcriberNeedsKey,
} from "./models";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

const HEADLINE = "Practice like it\u2019s a real seminar";
const SUBTITLE = "MockTalk: Real-time AI feedback on your slides, your delivery, and your argument.";

function TypingHero() {
  const [charIndex, setCharIndex] = useState(0);
  const [showSubtitle, setShowSubtitle] = useState(false);
  const done = charIndex >= HEADLINE.length;

  useEffect(() => {
    if (charIndex < HEADLINE.length) {
      const delay = 35 + Math.random() * 25;
      const timer = setTimeout(() => setCharIndex((i) => i + 1), delay);
      return () => clearTimeout(timer);
    }
    const fadeTimer = setTimeout(() => setShowSubtitle(true), 200);
    return () => clearTimeout(fadeTimer);
  }, [charIndex]);

  return (
    <div className="flex-1 flex flex-col gap-4 lg:pr-6">
      <h1
        className="text-6xl lg:text-7xl font-normal text-[#2d2a26] leading-tight"
        style={{ fontFamily: "var(--font-rosarivo, 'Rosarivo'), serif" }}
      >
        {HEADLINE.slice(0, charIndex)}
        {!done && (
          <span className="inline-block w-[3px] h-[0.85em] bg-[#2d2a26] align-baseline ml-0.5 animate-blink" />
        )}
      </h1>
      <p
        className={`text-xl text-[#3d3832] leading-relaxed max-w-lg transition-opacity duration-700 ${showSubtitle ? "opacity-100" : "opacity-0"}`}
        style={{ fontFamily: "var(--font-rosarivo, 'Rosarivo'), serif" }}
      >
        {SUBTITLE}
      </p>
    </div>
  );
}


function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="relative inline-flex items-center" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-[#8a7e6e] text-[#8a7e6e] text-[10px] font-bold leading-none hover:bg-[#8a7e6e]/10 cursor-pointer ml-1.5"
      >
        ?
      </button>
      {open && (
        <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 z-50 w-56 rounded-lg bg-white border border-stone-200 shadow-lg p-3">
          <p className="text-xs text-gray-600">{text}</p>
        </div>
      )}
    </div>
  );
}

export default function LandingPage() {
  const router = useRouter();
  const { setSettings, clearSettings } = useSettings();

  // Wipe sensitive data (API keys) from React context whenever the landing page mounts
  useEffect(() => { clearSettings(); }, [clearSettings]);

  // ── Form state, initialized from defaults ──────────────────────────────────
  const [aiCoachModel, setAiCoachModel] = useState<AICoachModel>(DEFAULT_SETTINGS.aiCoachModel);
  const [aiCoachApiKey, setAiCoachApiKey] = useState(DEFAULT_SETTINGS.aiCoachApiKey);
  const [transcriberModel, setTranscriberModel] = useState<TranscriberModel>(DEFAULT_SETTINGS.transcriberModel);
  const [transcriberApiKey, setTranscriberApiKey] = useState(DEFAULT_SETTINGS.transcriberApiKey);
  const [language, setLanguage] = useState(DEFAULT_SETTINGS.language);
  const [presentationDescription, setPresentationDescription] = useState(DEFAULT_SETTINGS.presentationDescription);
  const [slideChangeSensitivity, setSlideChangeSensitivity] = useState(DEFAULT_SETTINGS.slideChangeSensitivity);
  const [interruptionFrequency, setInterruptionFrequency] = useState(DEFAULT_SETTINGS.interruptionFrequency);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [starting, setStarting] = useState(false);
  const [activeTab, setActiveTab] = useState<"api-key" | "about">("about");
  const tabSectionRef = useRef<HTMLDivElement>(null);

  const handleTabClick = (tab: "api-key" | "about") => {
    setActiveTab(tab);
    tabSectionRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // ── Key-invalid warning modal ──────────────────────────────────────────────
  const [showKeyWarning, setShowKeyWarning] = useState(false);
  const [keyWarningMessages, setKeyWarningMessages] = useState<string[]>([]);
  const proceedFakeRef = useRef<(() => void) | null>(null);

  // ── Validation state ───────────────────────────────────────────────────────
  const [aiKeyValidating, setAiKeyValidating] = useState(false);
  const [aiKeyValid, setAiKeyValid] = useState(false);
  const [aiKeyError, setAiKeyError] = useState<string | null>(null);

  const [transcriberKeyValidating, setTranscriberKeyValidating] = useState(false);
  const [transcriberKeyValid, setTranscriberKeyValid] = useState(false);
  const [transcriberKeyError, setTranscriberKeyError] = useState<string | null>(null);

  // null = unchecked, "ok" = allowed, "not_local" = production env, "no_whisper" = local but missing package
  const [localEnvStatus, setLocalEnvStatus] = useState<"ok" | "not_local" | "no_whisper" | null>(null);

  // ── Validation helpers ─────────────────────────────────────────────────────

  const validateAiCoachKey = async (): Promise<boolean> => {
    if (!aiCoachApiKey.trim()) {
      setAiKeyError("Please enter an API key");
      return false;
    }
    setAiKeyValidating(true);
    setAiKeyValid(false);
    setAiKeyError(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/validate-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: getCoachProvider(aiCoachModel),
          api_key: aiCoachApiKey.trim(),
          model: aiCoachModel,
        }),
      });
      const data = await res.json();
      if (data.key_valid && data.model_valid) {
        setAiKeyValid(true);
        return true;
      } else {
        setAiKeyError(data.error || "Validation failed");
        return false;
      }
    } catch {
      setAiKeyError("Could not reach the backend server");
      return false;
    } finally {
      setAiKeyValidating(false);
    }
  };

  const validateTranscriberKey = async (): Promise<boolean> => {
    if (!transcriberApiKey.trim()) {
      setTranscriberKeyError("Please enter an API key");
      return false;
    }
    setTranscriberKeyValidating(true);
    setTranscriberKeyValid(false);
    setTranscriberKeyError(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/validate-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: getTranscriberProvider(transcriberModel),
          api_key: transcriberApiKey.trim(),
          model: getTranscriberModelId(transcriberModel),
        }),
      });
      const data = await res.json();
      if (data.key_valid && data.model_valid) {
        setTranscriberKeyValid(true);
        return true;
      } else {
        setTranscriberKeyError(data.error || "Validation failed");
        return false;
      }
    } catch {
      setTranscriberKeyError("Could not reach the backend server");
      return false;
    } finally {
      setTranscriberKeyValidating(false);
    }
  };

  const handleAiModelChange = (model: AICoachModel) => {
    setAiCoachModel(model);
    setAiCoachApiKey("");
    setAiKeyValid(false);
    setAiKeyError(null);
  };

  const handleAiKeyChange = (key: string) => {
    setAiCoachApiKey(key);
    setAiKeyValid(false);
    setAiKeyError(null);
  };

  const handleTranscriberModelChange = async (model: TranscriberModel) => {
    setTranscriberApiKey("");
    setTranscriberKeyValid(false);
    setTranscriberKeyError(null);
    setLocalEnvStatus(null);

    if (model === "local") {
      try {
        const res = await fetch(`${BACKEND_URL}/api/check-local-env`);
        const data = await res.json();
        if (!data.is_local) {
          setTranscriberModel("none");
          setLocalEnvStatus("not_local");
        } else if (!data.whisper_available) {
          setTranscriberModel("none");
          setLocalEnvStatus("no_whisper");
        } else {
          setTranscriberModel(model);
          setLocalEnvStatus("ok");
        }
      } catch {
        setTranscriberModel("none");
        setLocalEnvStatus("not_local");
      }
    } else {
      setTranscriberModel(model);
    }
  };

  const handleTranscriberKeyChange = (key: string) => {
    setTranscriberApiKey(key);
    setTranscriberKeyValid(false);
    setTranscriberKeyError(null);
  };

  const handleStart = async () => {
    setStarting(true);

    let aiOk = aiKeyValid;
    let transcriberOk = transcriberKeyValid;

    const promises: Promise<void>[] = [];

    if (aiCoachModel !== "none" && !aiKeyValid && !aiKeyError) {
      promises.push(validateAiCoachKey().then((ok) => { aiOk = ok; }));
    }
    if (transcriberNeedsKey(transcriberModel) && !transcriberKeyValid && !transcriberKeyError) {
      promises.push(validateTranscriberKey().then((ok) => { transcriberOk = ok; }));
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }

    const warnings: string[] = [];
    if (aiCoachModel !== "none" && !aiOk) warnings.push("AI Coach API key is invalid.");
    if (transcriberNeedsKey(transcriberModel) && !transcriberOk) warnings.push("Transcriber API key is invalid.");

    if (warnings.length > 0) {
      setKeyWarningMessages(warnings);
      proceedFakeRef.current = () => {
        setSettings({
          aiCoachModel: aiOk ? aiCoachModel : "none",
          aiCoachApiKey: aiOk ? aiCoachApiKey : "",
          transcriberModel: transcriberOk ? transcriberModel : "none",
          transcriberApiKey: transcriberOk ? transcriberApiKey : "",
          language,
          presentationDescription,
          slideChangeSensitivity,
          interruptionFrequency,
          fakeSession: true,
        });
        router.push("/setup");
      };
      setShowKeyWarning(true);
      setStarting(false);
      return;
    }

    setSettings({
      aiCoachModel,
      aiCoachApiKey,
      transcriberModel,
      transcriberApiKey,
      language,
      presentationDescription,
      slideChangeSensitivity,
      interruptionFrequency,
      fakeSession: aiCoachModel === "none",
    });
    setStarting(false);
    router.push("/setup");
  };

  // ── Shared input classes ───────────────────────────────────────────────────
  const inputClass = "rounded-lg border border-[rgba(168,155,138,0.4)] bg-[rgba(255,255,255,0.4)] px-3 py-2 text-sm text-[#2d2a26] placeholder-[#8a7e6e] outline-none focus:border-[#1f4d3a] transition-colors font-[var(--font-roboto-mono)]";
  const buttonAccent = "px-3 py-2 rounded-lg bg-[#1f4d3a] hover:bg-[#153629] disabled:bg-[#a89b8a] text-white text-sm font-medium whitespace-nowrap cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm";

  return (
    <div className="h-full flex flex-col overflow-y-auto" style={{ background: "linear-gradient(180deg, #d6cfc4 0%, #c4b8a5 40%, #b0a08a 100%)" }}>

      {/* ── Main content — sized so the API-key tab peeks at the bottom ── */}
      <div className="shrink-0 flex items-center justify-center px-4 py-12" style={{ minHeight: "calc(100vh - 4rem - 3.5rem)" }}>
        <div className="flex flex-col lg:flex-row gap-8 max-w-7xl w-full items-center">

          {/* ── Left column: branding ── */}
          <TypingHero />

          {/* ── Right column: settings + API key info ── */}
          <div className="flex-1 w-full max-w-[550px] flex flex-col gap-5">

            {/* ── Settings card ── */}
            <div className="bg-white/20 backdrop-blur-[12px] rounded-2xl border border-white/30 shadow-lg flex flex-col max-h-[650px]">
              {/* Fixed header */}
              <div className="px-6 pt-5 pb-3 border-b border-[rgba(140,125,105,0.25)] shrink-0">
                <div className="flex items-center gap-2">
                  {/* Wrench icon */}
                  <svg className="w-5 h-5 text-[#5a4f42]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
                  </svg>
                  <h2 className="text-lg text-base font-semibold text-[#2d2a26]">Settings</h2>
                </div>
              </div>

              {/* Scrollable settings content */}
              <div className="overflow-y-auto px-6 py-4 flex flex-col gap-4 flex-1">
                {/* Language */}
                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-[#4a4139] flex items-center">
                    Language
                    <InfoTip text="The language you will present in. I've only tested English so far." />
                  </span>
                  <select value={language} onChange={(e) => setLanguage(e.target.value)} className={inputClass}>
                    <option value="en">English</option>
                  </select>
                </label>

                {/* AI Coach model */}
                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-[#4a4139] flex items-center">
                    AI Advisor Model
                    <InfoTip text="The LLM that powers your AI advisor. Select 'None' to run in fake session mode without AI feedback." />
                  </span>
                  <select value={aiCoachModel} onChange={(e) => handleAiModelChange(e.target.value as AICoachModel)} className={inputClass}>
                    <option value="none">None</option>
                    {AI_COACH_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </label>

                {/* AI Coach API key */}
                {aiCoachModel !== "none" && (
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-[#4a4139]">AI Coach API Key</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        value={aiCoachApiKey}
                        onChange={(e) => handleAiKeyChange(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") validateAiCoachKey(); }}
                        placeholder={getKeyPlaceholder(getCoachProvider(aiCoachModel))}
                        className={`flex-1 ${inputClass}`}
                      />
                      <button type="button" onClick={validateAiCoachKey} disabled={aiKeyValidating || !aiCoachApiKey.trim()} className={buttonAccent}>
                        Validate
                      </button>
                      {aiKeyValidating && (
                        <svg className="animate-spin h-5 w-5 text-[#1f4d3a] shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                      )}
                      {aiKeyValid && !aiKeyValidating && (
                        <svg className="h-5 w-5 text-green-600 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                      )}
                    </div>
                    {aiKeyError && <span className="text-xs text-red-600">{aiKeyError}</span>}
                  </div>
                )}

                {/* Transcriber model */}
                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-[#4a4139] flex items-center">
                    Transcriber Model
                    <InfoTip text="The speech-to-text model that transcribes your presentation audio in real-time. Select 'Local' if you are hosting the app locally and want to save tokens. Select 'None' to disable transcription, although this will put you in fake session mode." />
                  </span>
                  <select value={transcriberModel} onChange={(e) => handleTranscriberModelChange(e.target.value as TranscriberModel)} className={inputClass}>
                    <option value="none">None</option>
                    {TRANSCRIBER_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                    <option value="local">Local (requires local server)</option>
                  </select>
                  {localEnvStatus === "ok" && (
                    <span className="flex items-center gap-1 text-xs text-green-600">
                      <svg className="h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                      Local transcription available
                    </span>
                  )}
                  {localEnvStatus === "not_local" && (
                    <span className="text-xs" style={{ color: "#C14B3A" }}>
                      Local transcription requires locally-hosted whisper model with faster-whisper installed. You can use this if you host this app on your own device.
                    </span>
                  )}
                  {localEnvStatus === "no_whisper" && (
                    <span className="text-xs" style={{ color: "#C14B3A" }}>
                      Missing faster_whisper package. Did you use requirements-local.txt?
                    </span>
                  )}
                </label>

                {/* Transcriber API key */}
                {transcriberNeedsKey(transcriberModel) && (
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-[#4a4139]">Transcriber API Key</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        value={transcriberApiKey}
                        onChange={(e) => handleTranscriberKeyChange(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") validateTranscriberKey(); }}
                        placeholder={getKeyPlaceholder(getTranscriberProvider(transcriberModel))}
                        className={`flex-1 ${inputClass}`}
                      />
                      <button type="button" onClick={validateTranscriberKey} disabled={transcriberKeyValidating || !transcriberApiKey.trim()} className={buttonAccent}>
                        Validate
                      </button>
                      {transcriberKeyValidating && (
                        <svg className="animate-spin h-5 w-5 text-[#1f4d3a] shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                      )}
                      {transcriberKeyValid && !transcriberKeyValidating && (
                        <svg className="h-5 w-5 text-green-600 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                      )}
                    </div>
                    {transcriberKeyError && <span className="text-xs text-red-600">{transcriberKeyError}</span>}
                  </div>
                )}

                {/* Presentation description */}
                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-[#4a4139] flex items-center">
                    Presentation Description
                    <InfoTip text="A brief description of your presentation topic. This helps the AI coach provide more relevant, context-aware feedback, but really you can leave this blank." />
                  </span>
                  <textarea
                    value={presentationDescription}
                    onChange={(e) => setPresentationDescription(e.target.value)}
                    placeholder="Briefly describe your presentation topic..."
                    rows={3}
                    className={`${inputClass} resize-none`}
                  />
                </label>

                {/* Advanced settings toggle */}
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="text-sm text-[#1f4d3a] hover:text-[#153629] font-medium text-left cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm"
                >
                  {showAdvanced ? "Hide Advanced Settings" : "Advanced Settings"}
                </button>

                {showAdvanced && (
                  <div className="flex flex-col gap-4 pl-2 border-l-2 border-[rgba(140,125,105,0.3)]">
                    {/* Slide change sensitivity */}
                    <label className="flex flex-col gap-1">
                      <span className="text-sm font-medium text-[#4a4139] flex items-center">
                        Slide Change Sensitivity: {slideChangeSensitivity}
                        <InfoTip text="Controls how sensitive the system is to detecting slide changes in your screen share. Higher values mean smaller visual changes will be detected as new slides." />
                      </span>
                      <input
                        type="range"
                        min={1}
                        max={10}
                        value={slideChangeSensitivity}
                        onChange={(e) => setSlideChangeSensitivity(Number(e.target.value))}
                        className="w-full accent-[#1f4d3a]"
                      />
                      <div className="flex justify-between text-xs text-[#8a7e6e]">
                        <span>Low</span>
                        <span>High</span>
                      </div>
                    </label>

                    {/* Interruption frequency */}
                    <label className="flex flex-col gap-1">
                      <span className="text-sm font-medium text-[#4a4139] flex items-center">
                        Interruption Frequency: {interruptionFrequency}
                        <InfoTip text="Controls how often the AI advisor will interrupt with feedback during your presentation. Higher values mean more frequent interruptions." />
                      </span>
                      <input
                        type="range"
                        min={1}
                        max={10}
                        value={interruptionFrequency}
                        onChange={(e) => setInterruptionFrequency(Number(e.target.value))}
                        className="w-full accent-[#1f4d3a]"
                      />
                      <div className="flex justify-between text-xs text-[#8a7e6e]">
                        <span>Less frequent</span>
                        <span>More frequent</span>
                      </div>
                    </label>
                  </div>
                )}
              </div>

              {/* Fixed footer with divider + start button */}
              <div className="px-6 pb-5 pt-3 border-t border-[rgba(140,125,105,0.25)] shrink-0">
                <button
                  onClick={handleStart}
                  disabled={starting}
                  className="w-full py-3 rounded-lg bg-[#1f4d3a] hover:bg-[#153629] disabled:bg-[#a89b8a] text-white font-semibold text-base flex items-center justify-center gap-2 cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm"
                >
                  {starting ? (
                    <>
                      <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Validating&hellip;
                    </>
                  ) : (
                    <>Start Presentation &rarr;</>
                  )}
                </button>
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* ── Info tabs section ── */}
      <div className="shrink-0" ref={tabSectionRef}>
        {/* Tab row */}
        <div className="max-w-5xl mx-auto ml-[80px] px-8 flex gap-1.5">
          {/* About tab */}
          <button
            type="button"
            onClick={() => handleTabClick("about")}
            className={`flex-1 inline-flex items-center justify-center gap-2.5 px-5 py-4 rounded-t-xl cursor-pointer transition-all ${
              activeTab === "about"
                ? "bg-[#ddd5c9] shadow-[0_-2px_6px_rgba(0,0,0,0.08)]"
                : "bg-[#cdc4b7] hover:bg-[#d5cdc1] opacity-75 hover:opacity-100"
            }`}
          >
            <svg className="w-5 h-5 text-[#5a4f42]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
            </svg>
            <span className="text-md font-bold text-[#1F1D1A]">What is this &amp; what to expect</span>
          </button>
          {/* API key tab */}
          <button
            type="button"
            onClick={() => handleTabClick("api-key")}
            className={`flex-1 inline-flex items-center justify-center gap-2.5 px-5 py-4 rounded-t-xl cursor-pointer transition-all ${
              activeTab === "api-key"
                ? "bg-[#ddd5c9] shadow-[0_-2px_6px_rgba(0,0,0,0.08)]"
                : "bg-[#cdc4b7] hover:bg-[#d5cdc1] opacity-75 hover:opacity-100"
            }`}
          >
            <svg className="w-5 h-5 text-[#5a4f42]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
            </svg>
            <span className="text-md font-bold text-[#1F1D1A]">How we handle your API key</span>
          </button>
        </div>

        {/* Content panel */}
        <div className="bg-[#ddd5c9]">
          <div className="max-w-5xl mx-auto px-8 py-6 text-sm text-[#1F1D1A] leading-relaxed">
            {activeTab === "about" && (
              <div className="flex flex-col gap-6 text-sm leading-relaxed">

                {/* ── What is MockTalk ── */}
                <div className="flex flex-col gap-2">
                  <h3 className="text-base font-semibold">What is this?</h3>
                  <p>
                    <strong>MockTalk</strong> is an AI-powered academic presentation
                    practice companion. Share your screen with your slides, speak into
                    your microphone, and get real-time interruptions and end-of-talk
                    discussions just like practicing in front of a PhD advisor in a lab
                    meeting. I haven't added other labmate simulating agents yet, so let's
                    pretend they've fallen asleep and it's just you and your advisor
                    in the room.
                  </p>
                </div>

                {/* ── How is it different ── */}
                <div className="flex flex-col gap-2">
                  <h3 className="text-base font-semibold">How is it different?</h3>
                  <p>
                    There are tools that create slides for you, tools that analyze
                    your public speaking skills, and tools that review a full
                    recording and hand you a report. MockTalk isn't any of those.
                  </p>
                  <p>
                    MockTalk is about the <em>experience</em> of presenting — the
                    flow, the interruptions, the back-and-forth discussion. I
                    personally use it to rehearse short-to-mid-length conference talks
                    (like a 13-minute VSS presentation) before I take it to an actual
                    lab meeting. The slides can be half-done, no one judges (unless
                    you want the AI to).
                  </p>
                  <p>
                    It's also cost-effective: there are real-time voice models (like
                    Gemini Live api), but they can get expensive fast. MockTalk creates a
                    real-time <em>feeling</em> using regular turn-taking models and
                    some infrastructure tricks. Important for me.
                  </p>
                </div>

                {/* ── How to use ── */}
                <div className="flex flex-col gap-2">
                  <h3 className="text-base font-semibold">How to use</h3>
                  <p>
                    Just follow the steps on screen. I've set it up to be
                    straightforward. Actually, you don't even need an API key to explore first: leave
                    everything as None / blank and proceed to see the UI. I call this
                    a "fake session" and you'll get placeholder feedbacks so you can poke
                    around first.
                  </p>
                </div>

                {/* ── What to expect ── */}
                <div className="flex flex-col gap-2">
                  <h3 className="text-base font-semibold">What to expect</h3>
                  <p>
                    The AI watches your slides (via screenshot images that is taken whenever 
                    a slide change is detected, so it's way cheaper than feeding videos) and 
                    reads your speech transcript. It will comment on clarity, pacing, slide
                    design (this is gonna depend on the multimodal ability of your model), 
                    and the strength of your argument. I've prompted it to be
                    a critical advisor, so responses can be harsh, but you can
                    always change the prompt.
                  </p>
                  <p>
                    Feedback appears as interruptions in real time in the advisor
                    panel as you present. When you finish the whole thing, there's a discussion
                    round where the AI asks deeper/big-picture questions.
                  </p>
                </div>

                {/* ── Model quality ── */}
                <div className="flex flex-col gap-2">
                  <h3 className="text-base font-semibold">A note on model quality</h3>
                  <p>
                    This is a BYOK (bring your own key) app, so the quality of
                    feedback depends entirely on which model you choose. But from my
                    experience, any thing below gpt-4o should be avioded, and:
                  </p>
                  <ul className="list-disc list-inside flex flex-col gap-1 pl-1">
                    <li>
                      <strong>GPT-4o</strong> — decent, but feedback tends to stay
                      general.
                    </li>
                    <li>
                      <strong>GPT-5.4 / Claude models</strong> — noticeably better
                      feedback, but pricier, so be careful.
                    </li>
                    <li>
                      <strong>Gemini models</strong> — I keep getting "model
                      overloaded" errors, so I haven't tested them much. You'll have
                      find out.
                    </li>
                  </ul>
                  <p>
                    If the AI questions are not making sense, you can always close the thread and start
                    fresh. That said, I find that even an overly general question can
                    be useful in the sense that thinking about <em>why</em> a question does not make sense forces me
                    to think, rather than just reading my slides. (Some of these
                    questions remind me of a confused audience member who isn't in
                    your field but still wants to ask something. Love them.)
                  </p>
                </div>

                {/* ── Bottom line ── */}
                <div className="flex flex-col gap-2">
                  <h3 className="text-base font-semibold">Bottom line</h3>
                  <p>
                    MockTalk is an <em>experience</em> tool, not a replacement for
                    your actual advisor's feedback. Use it to rehearse, get used to
                    the flow, the interruptions, and the discussion dynamics before
                    the real thing. If the model is powerful enough, the feedback
                    itself can be genuinely worth mulling over too.
                  </p>
                  <p>
                    To host this locally and make custom adjustments, check out the{" "}
                    <a href="#" className="underline">GitHub repo</a>.
                    
                    For the full backstory, check out my{" "}
                    <a href="#" className="underline">blog post</a> about the
                    motivation and development process.
                  </p>
                </div>

              </div>
            )} 
            {activeTab === "api-key" && (
              <div className="flex flex-col gap-6 text-sm leading-relaxed">

                <div className="flex flex-col gap-2">
                  <h3 className="text-base font-semibold">How we handle your API keys</h3>
                  <p>
                    MockTalk is a BYOK (Bring Your Own Key) application. You provide
                    your own API keys for the AI providers you want to use (OpenAI,
                    Google, Anthropic) and for transcription (OpenAI, Groq).
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <h3 className="text-base font-semibold">What happens to your keys</h3>
                  <p>
                    On the frontend, your keys are held in React application state
                    (an in-memory JavaScript variable), so not in cookies, not
                    in <code className="text-xs">localStorage</code>, and not in any
                    browser storage. They're gone the moment you close the tab,
                    refresh the page, or navigate back here on the main page.
                  </p>
                  <p>
                    When you start a session, your keys are sent to the MockTalk
                    backend server, which uses them to make API calls to the
                    providers on your behalf. The backend holds your keys in memory
                    for the duration of the session only. They are NEVER written to
                    disk, logged, or stored in any database.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <h3 className="text-base font-semibold">For extra peace of mind</h3>
                  <p>
                    MockTalk is fully open-source, so you can verify everything above
                    by reading the{" "}
                    <a href="#" className="underline">source code</a>. Of course, if you want
                    the most cautious setup, you can run MockTalk locally (that's what I do), or create
                    a provider API key with a limited budget and restricted model
                    access.
                  </p>
                </div>

              </div>
            )}        
            </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <footer className="shrink-0 border-t border-[rgba(140,125,105,0.3)] bg-[rgba(160,140,115,0.25)]">
        <div className="max-w-6xl mx-auto px-8 py-5 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-sm text-[#4a4139]">&copy; 2026 MockTalk</p>
          <div className="flex items-center gap-4">
            <a href="mailto:zhenans01@gmail.com" className="text-sm text-[#5a4f42] hover:text-[#2d2a26] transition-colors">
              zhenans01@gmail.com
            </a>
            {/* Website link */}
            <a href="https://shaox192.github.io/" target="_blank" rel="noopener noreferrer" className="text-[#5a4f42] hover:text-[#2d2a26] transition-colors" aria-label="Website">
              <svg className="w-5 h-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 003 12c0-1.605.42-3.113 1.157-4.418" />
              </svg>
            </a>
            {/* GitHub link */}
            <a href="https://github.com/shaox192" target="_blank" rel="noopener noreferrer" className="text-[#5a4f42] hover:text-[#2d2a26] transition-colors" aria-label="GitHub">
              <svg className="w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
              </svg>
            </a>
            {/* LinkedIn link */}
            <a href="https://www.linkedin.com/in/zhenanshao" target="_blank" rel="noopener noreferrer" className="text-[#5a4f42] hover:text-[#2d2a26] transition-colors" aria-label="LinkedIn">
              <svg className="w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
              </svg>
            </a>
          </div>
        </div>
      </footer>

      {/* ── Key-invalid warning modal ── */}
      {showKeyWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-[#ede8e0] rounded-2xl border border-[rgba(168,155,138,0.5)] shadow-lg p-6 max-w-sm w-full mx-4 flex flex-col gap-4">
            <h3 className="text-base font-semibold text-[#2d2a26]">API Key Problem</h3>
            <ul className="flex flex-col gap-1">
              {keyWarningMessages.map((msg, i) => (
                <li key={i} className="text-sm text-red-700">{msg}</li>
              ))}
            </ul>
            <p className="text-sm text-[#4a4139]">
              You can still give it a look &mdash; would you like to proceed in fake session mode?
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  setShowKeyWarning(false);
                  proceedFakeRef.current?.();
                }}
                className="w-full py-2 rounded-lg bg-[#1f4d3a] hover:bg-[#153629] text-white text-sm font-medium cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm"
              >
                Proceed in fake session mode
              </button>
              <button
                onClick={() => window.location.reload()}
                className="w-full py-2 rounded-lg border border-[rgba(168,155,138,0.5)] hover:bg-[rgba(255,255,255,0.3)] text-[#2d2a26] text-sm font-medium cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm"
              >
                No, let me fix the key
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
