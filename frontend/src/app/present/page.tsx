"use client";

// ── Imports ───────────────────────────────────────────────────────────────────
import { useRef, useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { MicVAD } from "@ricky0123/vad-web";
import { useSettings } from "../SettingsContext";

// ── Types ─────────────────────────────────────────────────────────────────────

type AppState = "idle" | "recording" | "discussion";
type SidebarView = "main" | "active_interruption" | "history_view" | "discussion";
type ResponseMode = "audio" | "chat";

interface ChatMessage {
  role: "advisor" | "user";
  text?: string;
  audioUrl?: string; // set for push-to-talk audio responses
  isError?: boolean; // true for inline error messages (shown in red)
}

interface Thread {
  id: number;
  advisorPrompt: string; // the first advisor message (used for history card preview)
  messages: ChatMessage[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Opening line for the post-presentation discussion thread
const DISCUSSION_OPENER =
  "Great presentation! Love it, but I have a few questions and follow-ups.";

// Ending line for the post-presentation discussion thread
const DISCUSSION_CLOSER =
  "All good. Thanks and good luck.";

// Ending line for the mid-presentation QA thread
const QA_CLOSER =
  "Sounds good. Let's move on.";

// ── MIME type detection ───────────────────────────────────────────────────────
// Picks the first audio MIME type that this browser's MediaRecorder supports.
// Priority: WebM/Opus (Chrome, Edge, Firefox) → MP4/AAC (Safari) → browser default.
// The `typeof` guard keeps this safe during Next.js server-side rendering.
function getSupportedAudioMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

// ── Audio helper ──────────────────────────────────────────────────────────────
// Files placed in /public are served at the root path in Next.js.
function playChime(): void {
  const audio = new Audio("/chime.mp3");
  audio.play().catch(() => {
    // Silently swallow autoplay-policy blocks; the visual cue still appears.
  });
}

// ── WAV encoding helpers ─────────────────────────────────────────────────
// Converts a Float32Array of PCM samples into a complete WAV file ArrayBuffer.
function encodeWAV(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  // fmt sub-chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // data sub-chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // Write PCM samples clamped to int16 range
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PresentPage() {
  const router = useRouter();
  const { settings, clearSettings, setSessionActive } = useSettings();

  // ── Route guard ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!settings || !settings.language) {
      router.replace("/");
    }
  }, [settings, router]);

  // ── Sync fake-session flag from landing-page validation ───────────────────
  useEffect(() => {
    if (settings?.fakeSession) setIsFakeSession(true);
    if (settings?.transcriberModel === "none") setTranscriptionDisabled(true);
  }, [settings]);

  // ── Refs ────────────────────────────────────────────────────────────────────

  const videoRef = useRef<HTMLVideoElement>(null);
  // All tracks in the combined presentation stream
  const tracksRef = useRef<MediaStreamTrack[]>([]);
  // Handles for the three interruption setTimeout calls
  const timerIdsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Temporary mic-only recorder used during push-to-talk responses
  const micRecorderRef = useRef<MediaRecorder | null>(null);
  const micChunksRef = useRef<Blob[]>([]);
  const micStreamRef = useRef<MediaStream | null>(null);
  // Monotonically-increasing ID for threads (avoids stale-closure issues)
  const threadIdRef = useRef(0);
  // Anchor element auto-scrolled to when new messages arrive
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Always-current mirror of activeThread for use inside stale WS closures
  const activeThreadRef = useRef<Thread | null>(null);
  // Always-current mirror of appState — guards the WS onmessage handler
  // against stale closure captures (e.g. interrupt arriving after discussion opens)
  const appStateRef = useRef<AppState>("idle");
  // True while a Q&A interruption is active — stale-closure-safe mirror of isInterrupted
  const isInterruptedRef = useRef(false);
  // Holds at most one queued interrupt message waiting for the current Q&A to resolve
  const pendingInterruptRef = useRef<string | null>(null);
  // Timestamp (ms) when the last user message was sent — used to enforce min typing indicator duration
  const typingStartTimeRef = useRef<number>(0);

  // Auto-scroll anchor for the live transcript box
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  // Stale-closure-safe mirror of pendingTranscript for the WS handler
  const pendingTranscriptRef = useRef("");

  // ── Server streaming refs ──────────────────────────────────────────────────
  // Live WebSocket connection to the Python backend
  const wsRef = useRef<WebSocket | null>(null);
  // Offscreen canvas used to capture and scale video frames before sending
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Handle for the 1-second frame-capture setInterval
  const frameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // VAD instance that streams speech-only audio segments to the backend
  const vadRef = useRef<MicVAD | null>(null);

  // ── State ───────────────────────────────────────────────────────────────────

  const [appState, setAppState] = useState<AppState>("idle");
  const [sidebarView, setSidebarView] = useState<SidebarView>("main");
  // Controls the red border / video overlay while main recorder is paused
  const [isInterrupted, setIsInterrupted] = useState(false);
  // The live thread open in the sidebar right now (interruption or discussion)
  const [activeThread, setActiveThread] = useState<Thread | null>(null);
  // All resolved threads, shown as history cards in the main sidebar view
  const [threadHistory, setThreadHistory] = useState<Thread[]>([]);
  // Which resolved thread is displayed in the read-only history_view
  const [historyViewThread, setHistoryViewThread] = useState<Thread | null>(null);

  const [responseMode, setResponseMode] = useState<ResponseMode>("chat");
  const [chatInput, setChatInput] = useState("");
  const [isPttRecording, setIsPttRecording] = useState(false);
  // True while waiting for the AI to process a QA audio response
  const [isQaProcessing, setIsQaProcessing] = useState(false);
  // True while the advisor is composing a reply — shows the bouncing-dots indicator
  const [isAdvisorTyping, setIsAdvisorTyping] = useState(false);
  // True when the backend reports no valid API key — shows warning banner
  const [isFakeSession, setIsFakeSession] = useState(false);
  // Live transcript state: finalized text + ongoing (pending) text
  const [finalTranscript, setFinalTranscript] = useState("");
  const [pendingTranscript, setPendingTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  // True when the backend reports no transcription method available
  const [transcriptionDisabled, setTranscriptionDisabled] = useState(false);
  // Sanity check status: null → not started, "checking" → dots, "done" → message shown
  const [sanityCheckStatus, setSanityCheckStatus] = useState<"checking" | "done" | null>(null);
  // Timestamp when sanity check started — used to enforce min 1s dot display
  const sanityCheckStartRef = useRef<number>(0);
  // Mid-presentation LLM error tracking
  const evalErrorCountRef = useRef(0);
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [showFakeInfo, setShowFakeInfo] = useState(false);
  const fakeInfoRef = useRef<HTMLDivElement>(null);
  const [errorModalMessage, setErrorModalMessage] = useState("");
  const [showLeaveModal, setShowLeaveModal] = useState(false);
  const [showResolveModal, setShowResolveModal] = useState(false);

  // Close fake-session info popover on outside click
  useEffect(() => {
    if (!showFakeInfo) return;
    const handler = (e: MouseEvent) => {
      if (fakeInfoRef.current && !fakeInfoRef.current.contains(e.target as Node)) {
        setShowFakeInfo(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showFakeInfo]);

  // ── Cleanup helper ─────────────────────────────────────────────────────────
  // Single source of truth for session teardown. Called from:
  // (a) useEffect unmount, (b) back-button popstate, (c) HeaderNav confirm
  const cleanupSession = useCallback(() => {
    tracksRef.current.forEach((t) => t.stop());
    tracksRef.current = [];
    timerIdsRef.current.forEach(clearTimeout);
    timerIdsRef.current = [];
    if (frameIntervalRef.current !== null) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    vadRef.current?.destroy();
    vadRef.current = null;
    if (micRecorderRef.current) {
      try { micRecorderRef.current.stop(); } catch { /* already stopped */ }
      micRecorderRef.current = null;
    }
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  // ── Effects ─────────────────────────────────────────────────────────────────

  // Keep activeThreadRef in sync so stale WS closures can read the current value
  useEffect(() => {
    activeThreadRef.current = activeThread;
  }, [activeThread]);

  // Keep appStateRef in sync so the WS onmessage handler (a stale closure)
  // always sees the live appState without needing to be recreated.
  useEffect(() => {
    appStateRef.current = appState;
  }, [appState]);

  // Scroll to the newest message whenever the active thread updates
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeThread]);

  // Auto-scroll live transcript to the bottom when new text arrives
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [finalTranscript, pendingTranscript]);

  // Graceful teardown when the component unmounts mid-session
  useEffect(() => {
    return () => {
      cleanupSession();
    };
  }, [cleanupSession]);

  // ── Navigation guard: beforeunload (tab/window close) ─────────────────────
  useEffect(() => {
    if (appState === "idle") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [appState]);

  // ── Navigation guard: browser back button ─────────────────────────────────
  useEffect(() => {
    if (appState === "idle") return;

    // Push a dummy history entry so pressing back pops it instead of leaving
    window.history.pushState(null, "", window.location.href);

    const handler = () => {
      setShowLeaveModal(true);
    };

    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [appState, cleanupSession, clearSettings, router]);

  // ── Thread & Response Helpers ────────────────────────────────────────────────

  // Appends a message using the functional-updater form to avoid stale closures
  const appendMessage = useCallback((msg: ChatMessage) => {
    setActiveThread((prev) =>
      prev ? { ...prev, messages: [...prev.messages, msg] } : prev
    );
  }, []);

  // ── Response Handlers ────────────────────────────────────────────────────────

  const submitChatResponse = useCallback(() => {
    const text = chatInput.trim();
    if (!text || wsRef.current?.readyState !== WebSocket.OPEN) return;
    appendMessage({ role: "user", text });
    setChatInput("");
    const type = appState === "discussion" ? "discussion_text" : "qa_text";
    setIsAdvisorTyping(true);
    typingStartTimeRef.current = Date.now();
    wsRef.current.send(JSON.stringify({ type, text }));
  }, [chatInput, appendMessage, appState]);

  // Toggle push-to-talk: first click starts recording, second stops & sends audio
  const togglePushToTalk = useCallback(async () => {
    if (isPttRecording) {
      // onstop fires below and handles the rest
      micRecorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      micStreamRef.current = stream;
      micChunksRef.current = [];

      const mimeType = getSupportedAudioMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) micChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(micChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        // Show the audio bubble immediately so the user sees their recording
        const audioUrl = URL.createObjectURL(blob);
        appendMessage({ role: "user", audioUrl });
        // Tear down the temporary mic stream
        micStreamRef.current?.getTracks().forEach((t) => t.stop());
        micStreamRef.current = null;
        micChunksRef.current = [];
        setIsPttRecording(false);
        // Encode and send to backend; show loading state while AI processes
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          setIsQaProcessing(true);
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = (reader.result as string).split(",")[1];
            const audioType = appState === "discussion" ? "discussion_audio" : "qa_audio";
            setIsAdvisorTyping(true);
            typingStartTimeRef.current = Date.now();
            wsRef.current?.send(JSON.stringify({ type: audioType, data: base64, mimeType: blob.type || "audio/webm" }));
          };
          reader.readAsDataURL(blob);
        }
      };
      recorder.start();
      micRecorderRef.current = recorder;
      setIsPttRecording(true);
    } catch {
      setError("Could not access microphone for audio response.");
    }
  }, [isPttRecording, appendMessage, appState]);

  // ── Interruption Handlers ────────────────────────────────────────────────────

  const triggerInterruption = useCallback((text: string) => {
    playChime();
    setActiveThread({
      id: ++threadIdRef.current,
      advisorPrompt: text,
      messages: [{ role: "advisor", text }],
    });
    setIsInterrupted(true);
    isInterruptedRef.current = true;
    setSidebarView("active_interruption");
    setResponseMode("chat");
    setChatInput("");
  }, []);

  // "Resolved, Moving On" — confirms, saves thread to history, resumes recorder
  const resolveThread = useCallback(() => {
    setShowResolveModal(true);
  }, []);

  const confirmResolveThread = useCallback(() => {
    setShowResolveModal(false);
    // Notify the server so it can reset is_interrupted and log the closure.
    wsRef.current?.send(JSON.stringify({ type: "resolve_thread" }));
    if (activeThread) setThreadHistory((prev) => [...prev, activeThread]);
    const pending = pendingInterruptRef.current;
    if (pending) {
      // Seamlessly transition to the next queued interruption
      pendingInterruptRef.current = null;
      triggerInterruption(pending);
    } else {
      setActiveThread(null);
      setIsInterrupted(false);
      isInterruptedRef.current = false;
      setSidebarView("main");
    }
  }, [activeThread, triggerInterruption]);

  // ── Presentation Handlers ────────────────────────────────────────────────────

  const startPresentation = useCallback(async () => {
    setError(null);
    setThreadHistory([]);
    setActiveThread(null);
    setIsInterrupted(false);
    setSidebarView("main");
    setSanityCheckStatus(null);
    setFinalTranscript("");
    setPendingTranscript("");
    pendingTranscriptRef.current = "";

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      const combinedStream = new MediaStream([
        ...screenStream.getVideoTracks(),
        ...micStream.getAudioTracks(),
      ]);
      tracksRef.current = combinedStream.getTracks();

      if (videoRef.current) videoRef.current.srcObject = combinedStream;

      {
        // ── WebSocket connection to Python backend ────────────────────────────
        const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
        const wsUrl = backendUrl.replace(/^http/, "ws") + "/ws";
        const ws = new WebSocket(wsUrl);
        ws.onerror = (e) => console.error("[WS] error:", e);
        ws.onclose = () => console.log("[WS] disconnected from backend");
        ws.onmessage = (event: MessageEvent<string>) => {
          try {
            const msg = JSON.parse(event.data) as {
              type: string;
              status?: string;
              message?: string;
              text?: string;
              is_final?: boolean;
              fake_session?: boolean;
            };

            if (msg.type === "session_config") {
              if (msg.fake_session) {
                setIsFakeSession(true);
                // Fake sessions skip the backend sanity check — drive the UI locally
                setSanityCheckStatus("checking");
                sanityCheckStartRef.current = Date.now();
                setTimeout(() => setSanityCheckStatus("done"), 1000);
              }
              return;
            }

            if (msg.type === "sanity_check") {
              if (msg.status === "ok") {
                const elapsed = Date.now() - sanityCheckStartRef.current;
                const delay = Math.max(0, 1000 - elapsed);
                setTimeout(() => setSanityCheckStatus("done"), delay);
              } else {
                // Error — show the error modal, clear sanity check state
                setSanityCheckStatus(null);
                setErrorModalMessage(msg.message || "AI coach sanity check failed.");
                setShowErrorModal(true);
              }
              return;
            }

            if (msg.type === "transcription_unavailable") {
              setTranscriptionDisabled(true);
              return;
            }

            if (msg.type === "transcript") {
              if (msg.is_final) {
                // Move pending text into finalized transcript, then clear pending.
                // Append \n so the next chunk starts on a new line.
                const pending = pendingTranscriptRef.current;
                if (pending) {
                  setFinalTranscript((prev) =>
                    (prev ? prev + "\n" : "") + pending
                  );
                }
                pendingTranscriptRef.current = "";
                setPendingTranscript("");
              } else if (msg.text) {
                pendingTranscriptRef.current =
                  (pendingTranscriptRef.current ? pendingTranscriptRef.current + " " : "") + msg.text;
                setPendingTranscript(pendingTranscriptRef.current);
              }
              return;
            }

            if (msg.type === "error") {
              console.warn("[WS] backend error:", msg.message);
              if (appStateRef.current === "recording" && !isInterruptedRef.current) {
                // Mid-presentation eval error — accumulate silently, modal at 3
                evalErrorCountRef.current += 1;
                if (evalErrorCountRef.current >= 3) {
                  setErrorModalMessage(msg.message || "Unknown error from the backend.");
                  setShowErrorModal(true);
                }
              } else {
                // Q&A or Discussion error — show inline red message, stop typing
                setIsAdvisorTyping(false);
                setIsQaProcessing(false);
                setActiveThread((prev) =>
                  prev
                    ? { ...prev, messages: [...prev.messages, { role: "advisor", text: msg.message || "Something went wrong — please try again.", isError: true }] }
                    : prev
                );
              }
              return;
            }

            if (msg.type === "interrupt" && msg.message) {
              // Successful LLM eval — reset mid-presentation error counter
              evalErrorCountRef.current = 0;
              // Discard interrupts that arrive after the presentation has ended.
              if (appStateRef.current !== "recording") return;
              // If a Q&A is already active, queue this interrupt instead of
              // overwriting the current thread.  It will fire once the current
              // Q&A resolves (pass or manual resolve).
              if (isInterruptedRef.current) {
                pendingInterruptRef.current = msg.message;
                console.log("[WS] interrupt queued — current Q&A still active");
                return;
              }
              triggerInterruption(msg.message);
            } else if (msg.type === "discussion_reply" && msg.message) {
              const elapsed = Date.now() - typingStartTimeRef.current;
              const delay = Math.max(0, 1000 - elapsed);
              setTimeout(() => {
                setIsAdvisorTyping(false);
                setIsQaProcessing(false);
                setActiveThread((prev) =>
                  prev
                    ? { ...prev, messages: [...prev.messages, { role: "advisor", text: msg.message }] }
                    : prev
                );
              }, delay);
            } else if (msg.type === "discussion_closed") {
              const current = activeThreadRef.current;
              const closedThread = current
                ? { ...current, messages: [...current.messages, { role: "advisor" as const, text: DISCUSSION_CLOSER }] }
                : null;
              if (closedThread) {
                setThreadHistory((prev) => [...prev, closedThread]);
                setHistoryViewThread(closedThread);
              }
              setActiveThread(null);
              setSidebarView("history_view");
              setAppState("idle");
              setSessionActive(false);
              ws.close();
            } else if (msg.type === "qa_result") {
              const elapsed = Date.now() - typingStartTimeRef.current;
              const delay = Math.max(0, 1000 - elapsed);
              if (msg.status === "follow_up" && msg.message) {
                // Advisor still has questions — append reply to the active thread
                setTimeout(() => {
                  setIsAdvisorTyping(false);
                  setIsQaProcessing(false);
                  setActiveThread((prev) =>
                    prev
                      ? { ...prev, messages: [...prev.messages, { role: "advisor", text: msg.message }] }
                      : prev
                  );
                }, delay);
              } else if (msg.status === "pass") {
                // Advisor is satisfied — append QA_CLOSER, save thread, resume recording.
                setTimeout(() => {
                  setIsAdvisorTyping(false);
                  setIsQaProcessing(false);
                  const current = activeThreadRef.current;
                  const closedThread = current
                    ? { ...current, messages: [...current.messages, { role: "advisor" as const, text: QA_CLOSER }] }
                    : null;
                  if (closedThread) setThreadHistory((prev) => [...prev, closedThread]);
                  const pending = pendingInterruptRef.current;
                  if (pending) {
                    // Seamlessly transition to the next queued interruption
                    pendingInterruptRef.current = null;
                    triggerInterruption(pending);
                  } else {
                    if (closedThread) setHistoryViewThread(closedThread);
                    setActiveThread(null);
                    setIsInterrupted(false);
                    isInterruptedRef.current = false;
                    setSidebarView("history_view");
                  }
                }, delay);
              }
            }
          } catch {
            console.warn("[WS] non-JSON message received:", event.data);
          }
        };
        wsRef.current = ws;

        // ── VAD-driven audio — only sends speech segments ─────────────────
        // Calling ws.send() before onopen fires throws "Still in CONNECTING state".
        ws.onopen = async () => {
          console.log("[WS] connected to backend");

          // Send client settings from context as the first message
          if (settings) {
            ws.send(JSON.stringify({ type: "client_settings", ...settings }));
          }

          ws.send(JSON.stringify({ type: "audio_config", mimeType: "audio/wav" }));

          const vad = await MicVAD.new({
            getStream: async () => new MediaStream(micStream.getAudioTracks()),
            baseAssetPath: "/",
            onnxWASMBasePath: "/",
            onSpeechEnd: (audio: Float32Array) => {
              if (ws.readyState !== WebSocket.OPEN) return;
              const wavBytes = encodeWAV(audio, 16000);
              const base64 = arrayBufferToBase64(wavBytes);
              ws.send(JSON.stringify({ type: "audio", data: base64 }));
            },
            positiveSpeechThreshold: 0.5,
            negativeSpeechThreshold: 0.45,
            redemptionMs: 560,
          });
          vad.start();
          vadRef.current = vad;
        };

        // ── Frame capture interval — 1 fps, longest edge capped at 1920 px ───
        const MAX_FRAME_EDGE = 1920;
        frameIntervalRef.current = setInterval(() => {
          const video = videoRef.current;
          const canvas = canvasRef.current;
          if (
            !video ||
            !canvas ||
            video.readyState < 2 ||
            ws.readyState !== WebSocket.OPEN
          )
            return;

          const vw = video.videoWidth;
          const vh = video.videoHeight;
          if (!vw || !vh) return;

          const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(vw, vh));
          canvas.width = Math.round(vw * scale);
          canvas.height = Math.round(vh * scale);

          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

          const base64 = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
          ws.send(JSON.stringify({ type: "frame", data: base64 }));
        }, 1000);
      }

      setAppState("recording");
      setSessionActive(true);
      // Start sanity check visual — the WS handler will transition to "done" or show error
      setSanityCheckStatus("checking");
      sanityCheckStartRef.current = Date.now();
    } catch (err) {
      // User cancelled the screen share or mic dialog — silently return to idle
      if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError")) {
        return;
      }
      setError(
        err instanceof Error
          ? err.message
          : "Failed to start. Please check your permissions."
      );
    }
  }, [triggerInterruption, settings, setSessionActive]);

  // Stops the presentation, then opens discussion
  const stopPresentation = useCallback(() => {
      if (tracksRef.current.length === 0) return;

      // Halt pending interruption timers
      timerIdsRef.current.forEach(clearTimeout);
      timerIdsRef.current = [];

      // Stop server streaming before tracks are torn down
      if (frameIntervalRef.current !== null) {
        clearInterval(frameIntervalRef.current);
        frameIntervalRef.current = null;
      }
      vadRef.current?.destroy();
      vadRef.current = null;
      // Keep the WebSocket open — signal discussion mode so the backend
      // suspends the eval loop.  The WS is closed in closeDiscussion.
      wsRef.current?.send(JSON.stringify({ type: "start_discussion" }));

      // Stop any in-progress push-to-talk session
      if (micRecorderRef.current) micRecorderRef.current.stop();

      // Move any unresolved active thread into history before closing
      if (activeThread) setThreadHistory((prev) => [...prev, activeThread]);
      setActiveThread(null);

      tracksRef.current.forEach((t) => t.stop());
      tracksRef.current = [];
      if (videoRef.current) videoRef.current.srcObject = null;

      setIsInterrupted(false);

      // Immediately open the post-presentation discussion thread
      setActiveThread({
        id: ++threadIdRef.current,
        advisorPrompt: DISCUSSION_OPENER,
        messages: [{ role: "advisor", text: DISCUSSION_OPENER }],
      });
      // Start typing indicator — waiting for the advisor's first discussion reply
      setIsAdvisorTyping(true);
      typingStartTimeRef.current = Date.now();
      setResponseMode("chat");
      setChatInput("");
      setSidebarView("discussion");
      setAppState("discussion");
    },
    [activeThread]
  );

  // Closes the post-presentation discussion and resets to idle
  const closeDiscussion = useCallback(() => {
    if (activeThread) setThreadHistory((prev) => [...prev, activeThread]);
    setActiveThread(null);
    setSidebarView("main");
    setAppState("idle");
    setSessionActive(false);
    setSanityCheckStatus(null);
    wsRef.current?.close();
    wsRef.current = null;
  }, [activeThread, setSessionActive]);

  // ── Route guard render ─────────────────────────────────────────────────────
  if (!settings) return null;

  // ── JSX ───────────────────────────────────────────────────────────────────────

  // Whether the sidebar is showing the combined interruption/discussion chat pane
  const showingChatPane =
    (sidebarView === "active_interruption" || sidebarView === "discussion") &&
    activeThread !== null;

  return (
    <div className="flex flex-row h-full bg-black p-4 gap-4 overflow-hidden text-gray-900">

      {/* ── Left Column ── */}
      <div className="flex flex-col w-[70%] gap-4 h-full">

        {/* ── Video Panel ── */}
        <div
          className={`relative flex items-center justify-center flex-1 bg-black rounded-2xl shadow-[6px_6px_0px_rgba(234,218,188,0.4)] p-4 overflow-hidden transition-all duration-200 ${
            isInterrupted
              ? "border-4 border-red-500"
              : "border-2 border-[#EADABC]"
          }`}
        >
          <div className="w-full h-full rounded-2xl overflow-hidden bg-black/5">
            <video
              ref={videoRef}
              className="w-full h-full object-contain"
              autoPlay
              muted
              playsInline
            />
          </div>

          {/* Idle placeholder */}
          {appState === "idle" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-[#EADABC] pointer-events-none">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-24 h-24"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1}
              >
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
              <p className="text-2xl">Screen preview will appear here</p>
            </div>
          )}

          {/* Discussion / ended placeholder */}
          {appState === "discussion" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[#EADABC] pointer-events-none">
              <p className="text-xl">
                Presentation ended — see sidebar for discussion
              </p>
            </div>
          )}

          {/* Interruption overlay (non-interactive so controls remain clickable) */}
          {isInterrupted && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/60 pointer-events-none">
              <span className="text-5xl">&#9995;</span>
              <p className="text-red-400 text-xl font-semibold tracking-wide px-6 text-center">
                Recording Paused — Advisor Interruption
              </p>
            </div>
          )}
        </div>

        {/* ── Live Transcript ── */}
        <div className="bg-[#EADABC] rounded-2xl shadow-[6px_6px_0px_rgba(234,218,188,0.4)] border-2 border-[#EADABC] px-5 py-3 h-[4.5rem] overflow-y-auto flex-shrink-0">
          {transcriptionDisabled ? (
            <p className="text-sm text-[#C14B3A] italic">
              Cannot load audio to text model, running in fake session mode: please check the api key, or run this locally with faster-whisper.
            </p>
          ) : finalTranscript || pendingTranscript ? (
            <p className="text-sm text-[#3E3225] leading-relaxed whitespace-pre-wrap">
              {finalTranscript}
              {pendingTranscript && (
                <span className="text-[#3E3225]/60 italic">
                  {finalTranscript ? "\n" : ""}{pendingTranscript}
                </span>
              )}
            </p>
          ) : (
            <p className="text-sm text-[#3E3225]/50 italic">
              {appState === "recording"
                ? "Listening..."
                : "Live transcript will appear here"}
            </p>
          )}
          <div ref={transcriptEndRef} />
        </div>

        {/* ── Controls (no bar) ── */}
        <div className="flex items-center justify-between flex-shrink-0">
          {error && (
            <p className="w-full text-center text-base text-red-600 absolute" role="alert">
              {error}
            </p>
          )}

          <button
            onClick={startPresentation}
            disabled={appState !== "idle"}
            className="px-5 py-2 rounded-lg bg-[#1f4d3a] hover:bg-[#153629] text-white disabled:opacity-40 disabled:cursor-not-allowed font-medium text-base cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm flex items-center gap-2"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6 4L20 12L6 20V4Z" stroke="white" strokeWidth="2" strokeLinejoin="round" />
            </svg>
            Start Presentation
          </button>

          <button
            onClick={() => stopPresentation()}
            disabled={appState !== "recording"}
            className="px-5 py-2 rounded-lg bg-red-100 text-red-700 hover:bg-red-200 disabled:opacity-40 disabled:cursor-not-allowed font-medium text-base cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm flex items-center gap-2"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
              <rect x="4" y="4" width="16" height="16" rx="1" stroke="currentColor" strokeWidth="2" />
            </svg>
            Stop Presentation
          </button>
        </div>
      </div>

      {/* ── Right Column ── */}
      <div className="w-[30%] h-full flex flex-col gap-4">

        {/* ── Prof Tile (Zoom-style participant box) ── */}
        <div className={`relative flex-shrink-0 h-28 rounded-2xl shadow-[6px_6px_0px_rgba(234,218,188,0.4)] border-2 border-[#EADABC] overflow-hidden flex items-center justify-center transition-colors duration-500 ${sanityCheckStatus === "done" ? "bg-black" : "bg-[#EADABC]"}`}>
          {sanityCheckStatus === "done" && (
            <>
              {/* Name label */}
              <span className="text-white text-3xl font-semibold select-none" style={{ fontFamily: "var(--font-rosarivo, 'Rosarivo'), serif" }}>Prof.</span>
              {/* Muted mic — bottom-left */}
              <div className="absolute bottom-2 left-2">
                <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" stroke="#CB531F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M19 10v2a7 7 0 01-14 0v-2" stroke="#CB531F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <line x1="3" y1="3" x2="21" y2="21" stroke="#CB531F" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
              {/* Muted video — bottom-right */}
              <div className="absolute bottom-2 right-2">
                <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="2" y="5" width="14" height="14" rx="2" stroke="#CB531F" strokeWidth="2" />
                  <path d="M22 7l-6 4 6 4V7z" stroke="#CB531F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <line x1="3" y1="3" x2="21" y2="21" stroke="#CB531F" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
            </>
          )}
          {/* Hand-raised indicator — top-right of Prof tile */}
          <span
            title={
              isInterrupted
                ? "Advisor has a question"
                : "No active interruptions"
            }
            className={`absolute top-2 right-2 text-xl transition-all duration-300 ${
              isInterrupted
                ? "opacity-100 drop-shadow-[0_0_8px_#facc15]"
                : "opacity-20"
            }`}
          >
            &#9995;
          </span>
        </div>

        {/* ── Advisor Feedback Panel (Sidebar) ── */}
        <div className="flex-1 min-h-0 bg-[#EADABC] rounded-2xl shadow-[6px_6px_0px_rgba(234,218,188,0.4)] border-2 border-[#EADABC] flex flex-col overflow-hidden">

        {/* SIDEBAR: Main View */}
        {sidebarView === "main" && (
          <>
            {/* Header */}
            <div className="flex items-center gap-2 px-5 py-4 border-b border-stone-200 flex-shrink-0">
              <div className="flex-1">
                <h2 className="text-lg font-semibold tracking-wide text-[#3E3225]">
                  Advisor Feedback
                </h2>
                {isFakeSession && (
                  <div className="relative flex items-center gap-1.5 mt-0.5" ref={fakeInfoRef}>
                    <span className="text-[#C14B3A] text-xs font-bold">FAKE SESSION</span>
                    <button
                      type="button"
                      onClick={() => setShowFakeInfo((v) => !v)}
                      className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-[#C14B3A] text-[#C14B3A] text-[10px] font-bold leading-none hover:bg-[#C14B3A]/10 cursor-pointer"
                    >
                      ?
                    </button>
                    {showFakeInfo && (
                      <div className="absolute left-0 top-full mt-1 z-50 w-56 rounded-lg bg-white border border-stone-200 shadow-lg p-3">
                        <p className="text-xs text-gray-600">
                          No valid API key was provided, so the advisor is running in demo mode.
                          Check your API key in settings, but you can still try the interface out.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Banner to return to an unresolved interruption */}
            {isInterrupted && (
              <button
                onClick={() => setSidebarView("active_interruption")}
                className="mx-4 mt-3 px-4 py-2 rounded-lg bg-red-50 border border-red-200 text-base text-red-700 hover:bg-red-100 text-left flex-shrink-0 cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm"
              >
                &#8617; Return to active question
              </button>
            )}

            {/* History cards + placeholder text */}
            <div className="flex-1 flex flex-col gap-3 px-4 py-4 overflow-y-auto" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
              {/* Sanity check bubble — non-clickable advisor greeting */}
              {sanityCheckStatus !== null && (
                <div className="max-w-[90%] rounded-lg px-3 py-2 bg-stone-100 text-gray-800 border border-stone-200">
                  <p className="text-sm font-medium mb-1 text-gray-500">Advisor</p>
                  {sanityCheckStatus === "checking" ? (
                    <div className="flex gap-1 items-center py-1">
                      <div className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                      <div className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                      <div className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                  ) : (
                    <p className="text-base leading-snug">I&apos;m here, you can get started.</p>
                  )}
                </div>
              )}

              {threadHistory.length === 0 && !isInterrupted && sanityCheckStatus === null ? (
                <p className="text-base text-gray-500">
                  {appState === "idle"
                    ? "Waiting for presentation to start..."
                    : "No interruptions yet."}
                </p>
              ) : null}
              {threadHistory.length === 0 && !isInterrupted && sanityCheckStatus === "done" ? (
                <p className="text-base text-gray-500">
                  No interruptions yet.
                </p>
              ) : null}

              {threadHistory.map((thread) => (
                <button
                  key={thread.id}
                  onClick={() => {
                    setHistoryViewThread(thread);
                    setSidebarView("history_view");
                  }}
                  className="w-full text-left px-4 py-3 rounded-lg bg-[#D94F22] text-white cursor-pointer shadow-md hover:shadow-xl hover:-translate-y-1 hover:brightness-105 active:translate-y-0 active:shadow-sm transition duration-200 ease-in-out"
                >
                  <p className="text-sm text-white/70 font-medium mb-0.5">
                    Thread #{thread.id}
                  </p>
                  <p className="text-base text-white">
                    {thread.advisorPrompt.length > 45
                      ? thread.advisorPrompt.slice(0, 45) + "..."
                      : thread.advisorPrompt}
                  </p>
                </button>
              ))}
            </div>
          </>
        )}

        {/* SIDEBAR: Active Interruption & Discussion Views */}
        {showingChatPane && (
          <>
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-stone-200 flex-shrink-0">
              <h2 className="flex-1 text-base font-semibold truncate text-gray-900">
                {sidebarView === "discussion"
                  ? "Discussion"
                  : "Advisor Question"}
              </h2>
              {sidebarView === "active_interruption" && (
                <span className="text-lg drop-shadow-[0_0_8px_#facc15]">
                  &#9995;
                </span>
              )}
            </div>

            {/* ── Message feed ── */}
            <div className="flex-1 flex flex-col gap-2 px-4 py-3 overflow-y-auto" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
              {activeThread!.messages.map((msg, i) => {
                if (msg.role === "advisor") {
                  return (
                    <div
                      key={i}
                      className={`self-start max-w-[90%] rounded-lg px-3 py-2 ${
                        msg.isError
                          ? "bg-red-50 text-red-800 border border-red-200"
                          : "bg-stone-100 text-gray-800 border border-stone-200"
                      }`}
                    >
                      <p className={`text-sm font-medium mb-1 ${msg.isError ? "text-red-500" : "text-gray-500"}`}>
                        {msg.isError ? "Error" : "Advisor"}
                      </p>
                      <p className="text-base leading-snug">
                        {msg.text}
                      </p>
                    </div>
                  );
                }
                // User audio bubble
                if (msg.audioUrl) {
                  return (
                    <div
                      key={i}
                      className="self-end max-w-[90%] rounded-lg px-3 py-2 bg-emerald-50 text-emerald-900 border border-emerald-200"
                    >
                      <p className="text-sm text-emerald-600 font-medium mb-1">
                        You
                      </p>
                      <audio
                        controls
                        src={msg.audioUrl}
                        className="h-8 w-48"
                      />
                    </div>
                  );
                }
                // User text bubble
                return (
                  <div
                    key={i}
                    className="self-end max-w-[90%] rounded-lg px-3 py-2 bg-emerald-50 text-emerald-900 border border-emerald-200"
                  >
                    <p className="text-sm text-emerald-600 font-medium mb-1">
                      You
                    </p>
                    <p className="text-base leading-snug">
                      {msg.text}
                    </p>
                  </div>
                );
              })}
              {/* Typing indicator — shown while waiting for advisor reply */}
              {isAdvisorTyping && (
                <div className="self-start max-w-[90%] rounded-lg px-4 py-3 bg-stone-100 border border-stone-200 flex gap-1 items-center">
                  <div className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                  <div className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                  <div className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              )}
              {/* Auto-scroll anchor */}
              <div ref={messagesEndRef} />
            </div>

            {/* ── Response mode toggle ── */}
            <div className="px-4 pt-2 flex gap-2 flex-shrink-0">
              <button
                onClick={() => setResponseMode("chat")}
                className={`flex-1 py-1.5 rounded text-sm font-medium cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm flex items-center justify-center gap-1.5 ${
                  responseMode === "chat"
                    ? "bg-[#D94F22] text-white"
                    : "bg-stone-100 text-gray-500 hover:bg-stone-200"
                }`}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Respond with Chat
              </button>
              <button
                onClick={() => setResponseMode("audio")}
                className={`flex-1 py-1.5 rounded text-sm font-medium cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm flex items-center justify-center gap-1.5 ${
                  responseMode === "audio"
                    ? "bg-[#D94F22] text-white"
                    : "bg-stone-100 text-gray-500 hover:bg-stone-200"
                }`}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M19 10v2a7 7 0 01-14 0v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M12 19v4M8 23h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Respond in Audio
              </button>
            </div>

            {/* ── Response input area ── */}
            <div className="px-4 py-2 flex-shrink-0">
              {responseMode === "chat" ? (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === "Enter" && submitChatResponse()
                    }
                    placeholder="Type your response..."
                    className="flex-1 rounded-lg bg-stone-50 border border-stone-200 px-3 py-1.5 text-base text-gray-900 placeholder-gray-400 outline-none focus:border-[#1f4d3a] transition-colors"
                  />
                  <button
                    onClick={submitChatResponse}
                    disabled={!chatInput.trim()}
                    className="px-3 py-1.5 rounded-lg bg-[#D94F22] hover:bg-[#153629] text-white disabled:opacity-40 disabled:cursor-not-allowed text-base font-medium cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm"
                  >
                    Send
                  </button>
                </div>
              ) : (
                /* Push-to-talk button — click to start, click again to stop */
                <button
                  onClick={togglePushToTalk}
                  disabled={isQaProcessing}
                  className={`w-full py-2 rounded-lg text-base font-medium cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm ${
                    isPttRecording
                      ? "bg-red-700 hover:bg-red-600 text-white animate-pulse"
                      : isQaProcessing
                      ? "bg-stone-200 text-gray-400 cursor-not-allowed"
                      : "bg-stone-100 text-gray-700 hover:bg-stone-200"
                  }`}
                >
                  {isPttRecording
                    ? "Stop Recording"
                    : isQaProcessing
                    ? "Processing..."
                    : "Push to Record"}
                </button>
              )}
            </div>

            {/* ── Exit button ── */}
            <div className="px-4 pb-4 flex-shrink-0">
              {sidebarView === "discussion" ? (
                <button
                  onClick={closeDiscussion}
                  className="w-full py-2 rounded-lg bg-stone-100 text-gray-700 hover:bg-stone-200 text-base font-medium cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm"
                >
                  Close Discussion
                </button>
              ) : (
                <button
                  onClick={resolveThread}
                  className="w-full py-2 rounded-lg bg-[#1f4d3a] hover:bg-[#153629] text-white text-base font-medium cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm"
                >
                  Resolved, Moving On
                </button>
              )}
            </div>
          </>
        )}

        {/* SIDEBAR: History View (read-only) */}
        {sidebarView === "history_view" && historyViewThread && (
          <>
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-stone-200 flex-shrink-0">
              <button
                onClick={() => setSidebarView("main")}
                className="text-gray-400 hover:text-gray-900 text-lg leading-none cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm"
                title="Back to Main"
              >
                &#8592;
              </button>
              <h2 className="flex-1 text-base font-semibold truncate text-gray-900">
                Thread #{historyViewThread.id}
              </h2>
              <span className="text-sm text-gray-500 flex-shrink-0">
                Read-only
              </span>
            </div>

            {/* Full read-only transcript */}
            <div className="flex-1 flex flex-col gap-2 px-4 py-3 overflow-y-auto" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
              {historyViewThread.messages.map((msg, i) => {
                if (msg.role === "advisor") {
                  return (
                    <div
                      key={i}
                      className={`self-start max-w-[90%] rounded-lg px-3 py-2 ${
                        msg.isError
                          ? "bg-red-50 text-red-800 border border-red-200"
                          : "bg-stone-100 text-gray-800 border border-stone-200"
                      }`}
                    >
                      <p className={`text-sm font-medium mb-1 ${msg.isError ? "text-red-500" : "text-gray-500"}`}>
                        {msg.isError ? "Error" : "Advisor"}
                      </p>
                      <p className="text-base leading-snug">
                        {msg.text}
                      </p>
                    </div>
                  );
                }
                if (msg.audioUrl) {
                  return (
                    <div
                      key={i}
                      className="self-end max-w-[90%] rounded-lg px-3 py-2 bg-emerald-50 text-emerald-900 border border-emerald-200"
                    >
                      <p className="text-sm text-emerald-600 font-medium mb-1">
                        You
                      </p>
                      <audio
                        controls
                        src={msg.audioUrl}
                        className="h-8 w-48"
                      />
                    </div>
                  );
                }
                return (
                  <div
                    key={i}
                    className="self-end max-w-[90%] rounded-lg px-3 py-2 bg-emerald-50 text-emerald-900 border border-emerald-200"
                  >
                    <p className="text-sm text-emerald-600 font-medium mb-1">
                      You
                    </p>
                    <p className="text-base leading-snug">
                      {msg.text}
                    </p>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>{/* end Advisor Feedback Panel */}
      </div>{/* end Right Column */}

      {/* Hidden canvas — used off-screen to capture & scale video frames */}
      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />

      {/* ── Mid-presentation error modal ── */}
      {showErrorModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-2xl border border-stone-200 shadow-lg p-6 max-w-sm w-full mx-4 flex flex-col gap-4">
            <h3 className="text-base font-semibold text-gray-900">Backend Error</h3>
            <p className="text-sm text-gray-600">
              Communication with the AI advisor failed. Here is the error:
            </p>
            <div className="max-h-32 overflow-y-auto rounded-lg bg-red-50 border border-red-200 px-3 py-2">
              <p className="text-sm text-red-700 whitespace-pre-wrap">{errorModalMessage}</p>
            </div>
            <p className="text-sm text-gray-600">
              Would you like to keep presenting while the backend retries, or go back to fix your settings?
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  evalErrorCountRef.current = -Infinity;
                  setShowErrorModal(false);
                }}
                className="w-full py-2 rounded-lg bg-[#1f4d3a] hover:bg-[#153629] text-white text-sm font-medium cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm"
              >
                Continue presenting
              </button>
              <button
                onClick={() => {
                  setShowErrorModal(false);
                  cleanupSession();
                  clearSettings();
                  router.replace("/");
                }}
                className="w-full py-2 rounded-lg border border-stone-300 hover:bg-stone-50 text-gray-700 text-sm font-medium cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm"
              >
                Go back to settings
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Leave presentation confirm modal ── */}
      {showLeaveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-2xl border border-stone-200 shadow-lg p-6 max-w-sm w-full mx-4 flex flex-col gap-4">
            <h3 className="text-base font-semibold text-gray-900">Leave Presentation?</h3>
            <p className="text-sm text-gray-600">
              Your current session will be lost.
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  setShowLeaveModal(false);
                  cleanupSession();
                  clearSettings();
                  router.replace("/");
                }}
                className="w-full py-2 rounded-lg bg-[#1f4d3a] hover:bg-[#153629] text-white text-sm font-medium cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm"
              >
                Leave
              </button>
              <button
                onClick={() => {
                  setShowLeaveModal(false);
                  window.history.pushState(null, "", window.location.href);
                }}
                className="w-full py-2 rounded-lg border border-stone-300 hover:bg-stone-50 text-gray-700 text-sm font-medium cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm"
              >
                Stay
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Resolve thread confirm modal ── */}
      {showResolveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-2xl border border-stone-200 shadow-lg p-6 max-w-sm w-full mx-4 flex flex-col gap-4">
            <h3 className="text-base font-semibold text-gray-900">Resolve Thread?</h3>
            <p className="text-sm text-gray-600">
              Are you sure? You cannot continue this thread later.
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={confirmResolveThread}
                className="w-full py-2 rounded-lg bg-[#1f4d3a] hover:bg-[#153629] text-white text-sm font-medium cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm"
              >
                Resolve
              </button>
              <button
                onClick={() => setShowResolveModal(false)}
                className="w-full py-2 rounded-lg border border-stone-300 hover:bg-stone-50 text-gray-700 text-sm font-medium cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
