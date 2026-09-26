"use client";

import { useEffect, useRef, useState } from "react";
import { CHUNK_MS, TARGET_SAMPLE_RATE } from "@/lib/audio";
import { Errors, messageForErrorCode } from "@/lib/errors";
import { describeGetUserMediaError } from "@/lib/media-error";
import {
  applySttEvent,
  emptyTranscript,
  projectTranscript,
  type SttEvent,
  type TranscriptState,
} from "@/lib/transcript";

type Status = "idle" | "starting" | "recording" | "stopping";

type LiveSession = {
  ws: WebSocket;
  stream: MediaStream;
  context: AudioContext;
  worklet: AudioWorkletNode;
  analyser: AnalyserNode;
  silent: GainNode;
  raf: number;
  stopRequested: boolean;
  terminal: boolean;
  receivedDone: boolean;
  resolveDone: () => void;
  donePromise: Promise<void>;
};

const STATUS_LABEL: Record<Status, string> = {
  idle: "Bereit",
  starting: "Verbinde…",
  recording: "Hört zu",
  stopping: "Wird abgeschlossen…",
};

export function DictationApp() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptState>(emptyTranscript);
  const [copied, setCopied] = useState(false);
  const [level, setLevel] = useState(0);
  const sessionRef = useRef<LiveSession | null>(null);
  const statusRef = useRef<Status>("idle");
  const startId = useRef(0);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    let active = true;
    fetch("/api/health", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: { configured?: boolean }) => {
        if (active && !body.configured) setError(Errors.missingApiKey);
      })
      .catch(() => {
        if (active) setError(Errors.serverUnreachable);
      });

    return () => {
      active = false;
      const session = sessionRef.current;
      if (!session) return;
      session.stopRequested = true;
      session.stream.getTracks().forEach((track) => track.stop());
      if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) {
        session.ws.close();
      }
      void session.context.close().catch(() => undefined);
      sessionRef.current = null;
    };
  }, []);

  async function startRecording() {
    if (sessionRef.current || statusRef.current === "starting" || statusRef.current === "recording") {
      return;
    }
    const id = ++startId.current;
    const cancelled = () => startId.current !== id;
    setError(null);
    setCopied(false);
    setTranscript(emptyTranscript());
    setStatus("starting");
    statusRef.current = "starting";

    if (!window.isSecureContext) {
      failStart(Errors.insecure);
      return;
    }
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioContext === "undefined" ||
      !("audioWorklet" in AudioContext.prototype)
    ) {
      failStart(Errors.micUnsupported);
      return;
    }

    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      const body = (await response.json()) as { configured?: boolean };
      if (cancelled()) return;
      if (!body.configured) {
        failStart(Errors.missingApiKey);
        return;
      }
    } catch {
      if (!cancelled()) failStart(Errors.serverUnreachable);
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (caught) {
      if (!cancelled()) failStart(describeGetUserMediaError(caught));
      return;
    }
    if (cancelled()) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    const context = new AudioContext();
    try {
      await context.resume();
      await context.audioWorklet.addModule("/pcm-worklet.js");
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      await context.close().catch(() => undefined);
      if (!cancelled()) failStart(Errors.audioStart);
      return;
    }
    if (cancelled()) {
      stream.getTracks().forEach((track) => track.stop());
      await context.close().catch(() => undefined);
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/stt`);
    ws.binaryType = "arraybuffer";

    let resolveDone: () => void = () => undefined;
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, "pcm-capture", {
      processorOptions: {
        targetSampleRate: TARGET_SAMPLE_RATE,
        chunkMs: CHUNK_MS,
      },
    });
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(worklet);
    source.connect(analyser);
    analyser.connect(silent);
    silent.connect(context.destination);

    const session: LiveSession = {
      ws,
      stream,
      context,
      worklet,
      analyser,
      silent,
      raf: 0,
      stopRequested: false,
      terminal: false,
      receivedDone: false,
      resolveDone,
      donePromise,
    };
    sessionRef.current = session;

    const meter = new Uint8Array(analyser.fftSize);
    const tick = () => {
      if (sessionRef.current !== session || session.stopRequested) return;
      analyser.getByteTimeDomainData(meter);
      let sum = 0;
      for (let i = 0; i < meter.length; i++) {
        const sample = ((meter[i] ?? 128) - 128) / 128;
        sum += sample * sample;
      }
      setLevel(Math.min(100, Math.round(Math.sqrt(sum / meter.length) * 220)));
      session.raf = requestAnimationFrame(tick);
    };
    session.raf = requestAnimationFrame(tick);

    const pending: ArrayBuffer[] = [];
    worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (session.stopRequested) return;
      const chunk = event.data;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
        return;
      }
      if (ws.readyState === WebSocket.CONNECTING) {
        pending.push(chunk);
        if (pending.length > 100) pending.shift();
      }
    };
    worklet.onprocessorerror = () => {
      if (session.terminal) return;
      session.terminal = true;
      setError(Errors.audioStart);
      void stopRecording();
    };

    ws.addEventListener("open", () => {
      if (session.stopRequested) return;
      for (const chunk of pending) ws.send(chunk);
      pending.length = 0;
    });

    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let payload: SttEvent & { code?: string };
      try {
        payload = JSON.parse(event.data) as SttEvent & { code?: string };
      } catch {
        return;
      }
      if (payload.type === "transcript.created") {
        setStatus("recording");
        statusRef.current = "recording";
        return;
      }
      if (payload.type === "transcript.partial" || payload.type === "transcript.done") {
        setTranscript((current) => applySttEvent(current, payload));
      }
      if (payload.type === "transcript.done") {
        session.receivedDone = true;
        session.resolveDone();
      }
      if (payload.type === "error") {
        session.terminal = true;
        setError(messageForErrorCode(payload.code));
        session.resolveDone();
        if (!session.stopRequested) void stopRecording();
      }
    });

    ws.addEventListener("close", () => {
      session.resolveDone();
      if (session.stopRequested || session.terminal || session.receivedDone) return;
      session.terminal = true;
      setError(Errors.connectionLost);
      releaseAudio(session);
      if (sessionRef.current === session) sessionRef.current = null;
      setLevel(0);
      setStatus("idle");
      statusRef.current = "idle";
    });
  }

  async function stopRecording() {
    startId.current += 1;
    const session = sessionRef.current;
    if (!session) {
      setStatus("idle");
      statusRef.current = "idle";
      setLevel(0);
      return;
    }
    if (session.stopRequested) return;
    session.stopRequested = true;
    setStatus("stopping");
    statusRef.current = "stopping";
    cancelAnimationFrame(session.raf);
    session.worklet.port.onmessage = null;
    session.worklet.disconnect();
    session.stream.getTracks().forEach((track) => track.stop());
    setLevel(0);

    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: "finalize" }));
      session.ws.send(JSON.stringify({ type: "audio.done" }));
      await Promise.race([
        session.donePromise,
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
    }

    if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) {
      session.ws.close();
    }
    session.analyser.disconnect();
    session.silent.disconnect();
    await session.context.close().catch(() => undefined);
    if (sessionRef.current === session) sessionRef.current = null;
    setStatus("idle");
    statusRef.current = "idle";
  }

  function failStart(message: string) {
    setError(message);
    setStatus("idle");
    statusRef.current = "idle";
  }

  const view = projectTranscript(transcript);
  const live = status === "starting" || status === "recording";
  const count = view.fullText.length;

  async function copyTranscript() {
    const text = view.fullText;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      if (!ok) {
        setError(Errors.copyFailed);
        return;
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  function downloadTranscript() {
    const blob = new Blob([view.fullText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `diktat-${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="shell">
      <header>
        <p className="kicker">Grok Transcribe</p>
        <h1>Diktat</h1>
        <p className="lede">
          Sprich auf Deutsch. Zwischenergebnisse erscheinen live, fertige Sätze bleiben im Transkript.
        </p>
      </header>

      {error ? (
        <div className="alert" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setError(null)}>
            Schließen
          </button>
        </div>
      ) : null}

      <section className="stage" aria-label="Aufnahme">
        <button
          type="button"
          className={live ? "mic live" : "mic"}
          aria-pressed={live}
          disabled={status === "stopping"}
          onClick={() => {
            if (live) void stopRecording();
            else void startRecording();
          }}
        >
          <span className="mic-icon">{live ? <StopIcon /> : <MicIcon />}</span>
          <span className="mic-label">
            {status === "stopping"
              ? "Wird abgeschlossen…"
              : live
                ? status === "recording"
                  ? "Aufnahme stoppen"
                  : "Verbinde…"
                : "Aufnahme starten"}
          </span>
        </button>
        <p className="status-row" aria-live="polite">
          <span className={`dot ${status}`} />
          <span>{STATUS_LABEL[status]}</span>
        </p>
        {live ? (
          <div className="meter" aria-hidden="true">
            <span style={{ width: `${level}%` }} />
          </div>
        ) : null}
      </section>

      <section className="sheet" aria-labelledby="transcript-heading">
        <div className="sheet-head">
          <h2 id="transcript-heading">Transkript</h2>
          <span>{count === 1 ? "1 Zeichen" : `${count} Zeichen`}</span>
        </div>
        <div className="sheet-body" aria-live="polite">
          {view.finalText ? <p className="final">{view.finalText}</p> : null}
          {view.partialText ? (
            <p className="partial">
              <span className="partial-label">Zwischenergebnis</span>
              {view.partialText}
            </p>
          ) : null}
          {!view.fullText ? (
            <p className="placeholder">Hier erscheint dein Transkript. Starte die Aufnahme und sprich los.</p>
          ) : null}
        </div>
      </section>

      <div className="actions">
        <button type="button" onClick={() => void copyTranscript()} disabled={!view.fullText}>
          {copied ? "Kopiert" : "Kopieren"}
        </button>
        <button
          type="button"
          onClick={() => {
            setTranscript(emptyTranscript());
            setCopied(false);
          }}
          disabled={!view.fullText || status !== "idle"}
        >
          Leeren
        </button>
        <button type="button" onClick={downloadTranscript} disabled={!view.fullText}>
          Als TXT herunterladen
        </button>
      </div>

      <p className="footnote">
        Das Mikrofon bleibt im Browser. Audio wird an diesen Server gestreamt und von dort an xAI
        weitergeleitet. Der API-Schlüssel verlässt den Server nicht.
      </p>
    </main>
  );
}

function releaseAudio(session: LiveSession) {
  cancelAnimationFrame(session.raf);
  session.worklet.port.onmessage = null;
  try {
    session.worklet.disconnect();
    session.analyser.disconnect();
    session.silent.disconnect();
  } catch {
    // Nodes may already be disconnected.
  }
  session.stream.getTracks().forEach((track) => track.stop());
  void session.context.close().catch(() => undefined);
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path
        d="M6 11a6 6 0 0 0 12 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M12 17v3M9 20h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  );
}
