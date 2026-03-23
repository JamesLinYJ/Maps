export interface SafeTraceEvent {
  event: string;
  sessionId: string;
  metadata?: Record<string, string | number | boolean | undefined>;
}

export interface TraceCollector {
  record(event: SafeTraceEvent): void;
  flush(): SafeTraceEvent[];
}

export function createTraceCollector(): TraceCollector {
  const events: SafeTraceEvent[] = [];

  return {
    record(event) {
      // 这里只保留安全摘要事件，不记录原始音频、完整 prompt 或敏感内容。
      events.push(event);
    },
    flush() {
      return [...events];
    }
  };
}
