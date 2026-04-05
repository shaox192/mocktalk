"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSettings } from "../SettingsContext";

export default function SetupPage() {
  const router = useRouter();
  const { settings } = useSettings();

  // ── Route guard ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!settings) {
      router.replace("/");
    }
  }, [settings, router]);

  // ── Screen share test ──────────────────────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const [screenStatus, setScreenStatus] = useState<"not_tested" | "working" | "stopped">("not_tested");
  const [screenActive, setScreenActive] = useState(false);

  const toggleScreenShare = useCallback(async () => {
    if (screenActive) {
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setScreenActive(false);
      setScreenStatus("stopped");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenStreamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setScreenActive(true);
      setScreenStatus("working");
      // Auto-stop if user ends share via browser UI
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        screenStreamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        setScreenActive(false);
        setScreenStatus("stopped");
      });
    } catch {
      setScreenStatus("stopped");
    }
  }, [screenActive]);

  // ── Audio test ─────────────────────────────────────────────────────────────
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const [micStatus, setMicStatus] = useState<"not_tested" | "working" | "stopped">("not_tested");
  const [micActive, setMicActive] = useState(false);
  const [volumeLevel, setVolumeLevel] = useState(0);

  const toggleMic = useCallback(async () => {
    if (micActive) {
      cancelAnimationFrame(animFrameRef.current);
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      audioContextRef.current?.close();
      audioContextRef.current = null;
      analyserRef.current = null;
      setMicActive(false);
      setMicStatus("stopped");
      setVolumeLevel(0);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const audioCtx = new AudioContext();
      audioContextRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;
      setMicActive(true);
      setMicStatus("working");

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const update = () => {
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((sum, v) => sum + v, 0) / dataArray.length;
        setVolumeLevel(Math.min(100, (avg / 128) * 100));
        animFrameRef.current = requestAnimationFrame(update);
      };
      update();
    } catch {
      setMicStatus("stopped");
    }
  }, [micActive]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      audioContextRef.current?.close();
      cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  if (!settings) return null;

  const statusText = (status: "not_tested" | "working" | "stopped") => {
    if (status === "not_tested") return "Not tested";
    if (status === "working") return "Working";
    return "Stopped";
  };

  const statusColor = (status: "not_tested" | "working" | "stopped") => {
    if (status === "working") return "text-green-600";
    if (status === "stopped") return "text-gray-500";
    return "text-[#8C3429]";
  };

  return (
    <div className="h-full flex items-center justify-center p-8 overflow-y-auto" style={{ background: "linear-gradient(180deg, #d6cfc4 0%, #c4b8a5 40%, #b0a08a 100%)" }}>
      <div className="flex flex-col gap-8 max-w-xl w-full">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-[#452B23]]">Setup & Test</h1>
          <p className="text-gray-600 mt-2">Test your screen share and microphone before starting</p>
        </div>

        {/* ── Screen share test ── */}
        <div className="bg-white/20 backdrop-blur-[12px] rounded-2xl border border-white/30 shadow-lg p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900">Screen Share</h2>
            <span className={`text-sm font-medium ${statusColor(screenStatus)}`}>
              {statusText(screenStatus)}
            </span>
          </div>

          {/* Video preview */}
          <div className={`rounded-xl overflow-hidden bg-black/5 ${screenActive ? "h-48" : "h-0"} transition-all duration-300`}>
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="w-full h-full object-contain"
            />
          </div>

          <button
            onClick={toggleScreenShare}
            className={`w-full py-2 rounded-lg text-sm font-medium cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm ${
              screenActive
                ? "bg-red-100 text-red-700 hover:bg-red-200"
                : "bg-stone-100 text-gray-700 hover:bg-stone-200"
            }`}
          >
            {screenActive ? "Stop Screen Share" : "Test Screen Share"}
          </button>
        </div>

        {/* ── Audio test ── */}
        <div className="bg-white/20 backdrop-blur-[12px] rounded-2xl border border-white/30 shadow-lg p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900">Microphone</h2>
            <span className={`text-sm font-medium ${statusColor(micStatus)}`}>
              {statusText(micStatus)}
            </span>
          </div>

          {/* Volume bar */}
          {micActive && (
            <div className="w-full h-4 bg-stone-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-green-500 rounded-full transition-all duration-75"
                style={{ width: `${volumeLevel}%` }}
              />
            </div>
          )}

          <button
            onClick={toggleMic}
            className={`w-full py-2 rounded-lg text-sm font-medium cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm ${
              micActive
                ? "bg-red-100 text-red-700 hover:bg-red-200"
                : "bg-stone-100 text-gray-700 hover:bg-stone-200"
            }`}
          >
            {micActive ? "Stop Microphone" : "Test Microphone"}
          </button>
        </div>

        {/* ── Navigation ── */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.push("/")}
            className="text-md text-gray-600 hover:text-gray-900 font-medium cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm"
          >
            &larr; Back to Settings
          </button>
          <button
            onClick={() => router.push("/present")}
            className="px-6 py-3 rounded-lg bg-[#1f4d3a] hover:bg-[#153629] text-white font-semibold text-base cursor-pointer transition duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:shadow-sm"
          >
            Start Presentation &rarr;
          </button>
        </div>
      </div>
    </div>
  );
}
