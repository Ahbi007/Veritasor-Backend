import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture mocks before module imports
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock('../../utils/logger.js', () => ({
  logger: mockLogger,
}));

const mockConfig = {
  statsd: {
    host: '127.0.0.1',
    port: 8125,
    prefix: 'veritasor.',
    dualWriteEnabled: true,
    dualWriteIntervalMs: 10_000,
  },
};

vi.mock('../../config/index.js', () => ({
  config: mockConfig,
}));

vi.mock('../../metrics.js', () => ({
  metricsRegistry: { getMetricsAsJSON: vi.fn().mockReturnValue([]) },
  statsdDualWriteRunsTotal: { inc: vi.fn() },
  statsdDualWriteErrorsTotal: { inc: vi.fn() },
  statsdDualWriteDurationMs: { observe: vi.fn() },
  statsdDualWriteMetricsCount: { set: vi.fn() },
}));

vi.mock('../statsdClient.js', () => ({
  StatsDClient: vi.fn().mockImplementation(() => ({
    gauge: vi.fn(),
    increment: vi.fn(),
    timing: vi.fn(),
    histogram: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  sanitizeTagValue: vi.fn((v: string) => v.replace(/[^a-zA-Z0-9_.\-]/g, '_')),
}));

vi.mock('../statsdDualWrite.js', () => {
  const handle = {
    stop: vi.fn().mockResolvedValue(undefined),
  };
  return {
    startStatsdDualWrite: vi.fn().mockReturnValue(handle),
    StatsdDualWriteHandle: {} as any,
  };
});

import {
  startStatsdDualWriteIfEnabled,
  stopStatsdDualWriteIfNeeded,
} from '../statsdBootstrap.js';
import { startStatsdDualWrite } from '../statsdDualWrite.js';
import { StatsDClient } from '../statsdClient.js';

describe('statsdBootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.statsd.dualWriteEnabled = true;
  });

  afterEach(async () => {
    // Ensure no handle leaks between tests
    await stopStatsdDualWriteIfNeeded();
    mockConfig.statsd.dualWriteEnabled = true;
  });

  describe('startStatsdDualWriteIfEnabled', () => {
    it('creates a StatsdClient and starts dual-write when enabled', () => {
      startStatsdDualWriteIfEnabled();

      expect(StatsdClient).toHaveBeenCalledWith({
        host: '127.0.0.1',
        port: 8125,
        prefix: 'veritasor.',
      });
      expect(startStatsdDualWrite).toHaveBeenCalled();
    });

    it('logs a warning and skips if already running', () => {
      startStatsdDualWriteIfEnabled();
      vi.clearAllMocks();

      startStatsdDualWriteIfEnabled();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Statsd dual-write already running; ignoring duplicate start',
      );
      // No second client created
      expect(StatsDClient).not.toHaveBeenCalled();
      expect(startStatsdDualWrite).not.toHaveBeenCalled();
    });

    it('does not start dual-write when the feature flag is disabled', () => {
      mockConfig.statsd.dualWriteEnabled = false;

      startStatsdDualWriteIfEnabled();

      expect(StatsDClient).not.toHaveBeenCalled();
      expect(startStatsdDualWrite).not.toHaveBeenCalled();
    });

    it('respects an explicit dualWriteEnabled override of false', () => {
      startStatsdDualWriteIfEnabled({ dualWriteEnabled: false });

      expect(StatsdClient).not.toHaveBeenCalled();
      expect(startStatsdDualWrite).not.toHaveBeenCalled();
    });

    it('respects an explicit dualWriteEnabled override of true even when config is disabled', () => {
      mockConfig.statsd.dualWriteEnabled = false;

      startStatsdDualWriteIfEnabled({ dualWriteEnabled: true });

      expect(StatsDClient).toHaveBeenCalled();
      expect(startStatsdDualWrite).toHaveBeenCalled();
    });

    it('logs and returns without throwing when client construction fails', () => {
      (StatsDClient as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error('client init failed');
      });

      expect(() => startStatsdDualWriteIfEnabled()).not.toThrow();
      expect(mockLogger.error).toHaveBeenCalled();
      expect(startStatsdDualWrite).not.toHaveBeenCalled();
    });

    it('logs and returns without throwing when startStatsdDualWrite fails', () => {
      (startStatsdDualWrite as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error('start failed');
      });

      expect(() => startStatsdDualWriteIfEnabled()).not.toThrow();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('allows a subsequent start after a failed start', () => {
      (startStatsdDualWrite as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error('start failed');
      });

      startStatsdDualWriteIfEnabled();
      vi.clearAllMocks();

      startStatsdDualWriteIfEnabled();

      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        'Statsd dual-write already running; ignoring duplicate start',
      );
      expect(startStatsdDualWrite).toHaveBeenCalled();
    });
  });

  describe('stopStatsdDualWriteIfNeeded', () => {
    it('is a noop when nothing is running', async () => {
      await expect(stopStatsdDualWriteIfNeeded()).resolves.toBeUndefined();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('stops the dual-write handle when running', async () => {
      startStatsdDualWriteIfEnabled();
      const handle = (startStatsdDualWrite as ReturnType<typeof vi.fn>).mock
        .results[0].value;

      await stopStatsdDualWriteIfNeeded();

      expect(handle.stop).toHaveBeenCalled();
    });

    it('clears the handle after stopping, making a second stop a noop', async () => {
      startStatsdDualWriteIfEnabled();

      await stopStatsdDualWriteIfNeeded();
      const handle = (startStatsdDualWrite as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      expect(handle.stop).toHaveBeenCalledTimes(1);

      vi.clearAllMocks();

      // Second stop should not call handle.stop again
      await stopStatsdDualWriteIfNeeded();
      expect(handle.stop).not.toHaveBeenCalled();
    });

    it('logs a warning and clears handle when stop throws', async () => {
      startStatsdDualWriteIfEnabled();
      const handle = (startStatsdDualWrite as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      (handle.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('close failed'),
      );

      await stopStatsdDualWriteIfNeeded();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { err: 'close failed' },
        'Statsd dual-write stop error',
      );

      // Handle should be cleared even after error
      await stopStatsdDualWriteIfNeeded();
      expect(handle.stop).toHaveBeenCalledTimes(1);
    });

    it('allows a new start after a successful stop', async () => {
      startStatsdDualWriteIfEnabled();
      await stopStatsdDualWriteIfNeeded();
      vi.clearAllMocks();

      startStatsdDualWriteIfEnabled();

      expect(StatsdClient).toHaveBeenCalled();
      expect(startStatsdDualWrite).toHaveBeenCalled();
    });
  });
});
