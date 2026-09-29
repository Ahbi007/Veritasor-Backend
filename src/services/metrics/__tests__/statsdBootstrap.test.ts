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
    // Ensure module-level handle state is cleared between tests.
    await stopStatsdDualWriteIfNeeded();
    vi.clearAllMocks();
  });

  describe('startStatsdDualWriteIfEnabled', () => {
    it('creates a StatsD client and starts dual-write when enabled', () => {
      startStatsdDualWriteIfEnabled();

      expect(StatsdClient).toHaveBeenCalledWith({
        host: '127.0.0.1',
        port: 8125,
        prefix: 'veritasor.',
      });
      expect(startStatsdDualWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          intervalMs: 10_000,
        }),
      );
    });

    it('logs initialisation details on successful start', () => {
      startStatsdDualWriteIfEnabled();

      expect(mockLogger.info).toHaveBeenCalledWith(
        {
          host: '127.0.0.1',
          port: 8125,
          prefix: 'veritasor.',
          intervalMs: 10_000,
        },
        'Statsd dual-write initialised',
      );
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
      expect(mockLogger.info).not.toHaveBeenCalled();
    });

    it('respects a change to the feature flag between calls', () => {
      mockConfig.statsd.dualWriteEnabled = false;
      startStatsdDualWriteIfEnabled();
      expect(startStatsdDualWrite).not.toHaveBeenCalled();

      mockConfig.statsd.dualWriteEnabled = true;
      startStatsdDualWriteIfEnabled();
      expect(startStatsdDualWrite).toHaveBeenCalled();
    });
  });

  describe('stopStatsdDualWriteIfNeeded', () => {
    it('is a no-op when nothing is running', async () => {
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

    it('clears the handle after stopping, making a second stop a no-op', async () => {
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

    it('allows a fresh start after stopping', async () => {
      startStatsdDualWriteIfEnabled();
      await stopStatsdDualWriteIfNeeded();

      vi.clearAllMocks();
      startStatsdDualWriteIfEnabled();

      expect(StatsdClient).toHaveBeenCalledTimes(1);
      expect(startStatsdDualWrite).toHaveBeenCalledTimes(1);
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

    it('surfaces non-Error rejections with a stable message', async () => {
      startStatsdDualWriteIfEnabled();
      const handle = (startStatsdDualWrite as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      (handle.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce('boom');

      await stopStatsdDualWriteIfNeeded();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { err: 'undefined' },
        'Statsd dual-write stop error',
      );
    });
  });
});
