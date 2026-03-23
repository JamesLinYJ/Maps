export type VoiceStatus = "idle" | "listening" | "thinking" | "speaking" | "error";

export interface VoiceTelemetryEvent {
  event:
    | "voice_session_started"
    | "voice_session_ended"
    | "asr_transcript_received"
    | "intent_classified"
    | "tool_call_started"
    | "tool_calls_completed"
    | "tool_calls_failed"
    | "map_action_plan_generated"
    | "narration_generated"
    | "tts_playback_started"
    | "tts_playback_completed";
  sessionId: string;
  language?: string;
  intent?: string;
  toolCount?: number;
  actionCount?: number;
  error?: string;
}

export interface VoiceTelemetrySink {
  record(event: VoiceTelemetryEvent): void;
}

export interface AsrCallbacks {
  onPartialTranscript(text: string): void;
  onFinalTranscript(text: string): void;
  onStatusChange(status: VoiceStatus): void;
  onError(message: string): void;
}

export interface AsrAdapter {
  readonly isSupported: boolean;
  start(callbacks: AsrCallbacks): Promise<void>;
  stop(): void;
}

export interface TtsAdapter {
  readonly isSupported: boolean;
  speak(text: string, language: string): Promise<void>;
  stop(): void;
}

interface BrowserSpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: {
      transcript: string;
    };
  }>;
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognitionInstance;

function getSpeechRecognitionConstructor(): BrowserSpeechRecognitionConstructor | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  // 兼容标准 SpeechRecognition 和旧版 webkitSpeechRecognition。
  return (
    (window as typeof window & { SpeechRecognition?: BrowserSpeechRecognitionConstructor }).SpeechRecognition ??
    (window as typeof window & { webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor })
      .webkitSpeechRecognition
  );
}

export function createBrowserAsrAdapter(language = "zh-CN"): AsrAdapter {
  const SpeechRecognition = getSpeechRecognitionConstructor();
  let recognition: BrowserSpeechRecognitionInstance | null = null;

  return {
    isSupported: Boolean(SpeechRecognition),
    async start(callbacks) {
      if (!SpeechRecognition) {
        // 浏览器不支持时直接回退文本输入，避免语音按钮表面可用、实际无响应。
        callbacks.onError("当前浏览器不支持语音识别，请改用文本输入。");
        callbacks.onStatusChange("error");
        return;
      }

      recognition = new SpeechRecognition();
      recognition.lang = language;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onstart = () => callbacks.onStatusChange("listening");
      recognition.onend = () => callbacks.onStatusChange("idle");
      recognition.onerror = (event) => {
        callbacks.onError(event.error);
        callbacks.onStatusChange("error");
      };
      recognition.onresult = (event) => {
        let partialTranscript = "";

        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result[0].transcript.trim();

          if (result.isFinal) {
            // 只有最终结果才触发一次完整回合，中间结果只更新实时转写。
            callbacks.onFinalTranscript(transcript);
          } else {
            partialTranscript += transcript;
          }
        }

        if (partialTranscript) {
          callbacks.onPartialTranscript(partialTranscript);
        }
      };
      recognition.start();
    },
    stop() {
      recognition?.stop();
    }
  };
}

export function createBrowserTtsAdapter(): TtsAdapter {
  return {
    isSupported: typeof window !== "undefined" && "speechSynthesis" in window,
    async speak(text, language) {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        return;
      }

      // 先清掉上一轮播报，避免叠音和残留语音打断新一轮讲解。
      window.speechSynthesis.cancel();

      await new Promise<void>((resolve, reject) => {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = language;
        utterance.onend = () => resolve();
        utterance.onerror = () => reject(new Error("Speech synthesis failed."));
        window.speechSynthesis.speak(utterance);
      });
    },
    stop() {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    }
  };
}

export function createSilentTtsAdapter(): TtsAdapter {
  return {
    isSupported: true,
    async speak() {
      // 测试或受限环境下保留接口，但不实际发声。
      return;
    },
    stop() {
      return;
    }
  };
}
