// Voice input through the browser's built-in Web Speech API: no API key, no extra package.
// Supported in Chrome, Edge and Safari (Chrome/Edge send the audio to their own speech service).
// Firefox has no support, so callers hide the mic button when `supported` is false.
import { useEffect, useRef, useState } from "react";

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

const Ctor: (new () => Recognition) | undefined =
  typeof window === "undefined" ? undefined : (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access was blocked. Allow it in the browser's address bar and try again.",
  "service-not-allowed": "Microphone access was blocked. Allow it in the browser's address bar and try again.",
  "no-speech": "Didn't hear anything. Tap the mic and speak your question.",
  "audio-capture": "No microphone was found.",
  network: "Voice typing needs an internet connection.",
};

/** onText gets the full transcript so far (final + in-progress words) each time it changes. */
export function useSpeech(onText: (text: string) => void, lang = "en-IN") {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const cb = useRef(onText);
  cb.current = onText;

  useEffect(() => () => rec.current?.abort(), []);

  function start() {
    if (!Ctor || listening) return;
    const r = new Ctor();
    r.lang = lang;
    r.interimResults = true;
    r.continuous = false; // stops by itself after a pause, which suits one question
    let finalText = "";
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      cb.current((finalText + interim).trim());
    };
    r.onerror = (e) => {
      if (e.error !== "aborted") setError(ERRORS[e.error] ?? "Voice typing stopped. Try again.");
    };
    r.onend = () => setListening(false);
    setError(null);
    rec.current = r;
    r.start();
    setListening(true);
  }

  function stop() {
    rec.current?.stop();
  }

  return { supported: !!Ctor, listening, error, start, stop };
}
