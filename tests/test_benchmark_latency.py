import unittest

from experiments.benchmark_latency import select_frames, summarize


class BenchmarkTests(unittest.TestCase):
    def test_sampling_is_unique_and_spans_clip(self):
        frames = list(range(13))
        self.assertEqual(select_frames(frames, 1), [6])
        for count in (3, 5, 10, 13):
            result = select_frames(frames, count)
            self.assertEqual(len(set(result)), count)
            self.assertEqual((result[0], result[-1]), (0, 12))
        for count in (0, 14):
            with self.assertRaises(ValueError):
                select_frames(frames, count)

    def test_failures_excluded_and_cache_groups_separate(self):
        trials = [{"frame_count": 3, "request_bytes": 100, "valid": valid,
                   "elapsed_seconds": seconds, "cached_tokens": cached}
                  for valid, seconds, cached in [(True, 1, 0), (True, 3, 20), (False, 100, 0)]]
        row = summarize(trials)[0]
        self.assertEqual(row["median_seconds"], 2)
        self.assertEqual(row["failures"], 1)
        self.assertEqual(row["observed_uncached_median_seconds"], 1)
        self.assertEqual(row["observed_cached_median_seconds"], 3)

    def test_all_failed_has_no_latency_statistic(self):
        row = summarize([{"frame_count": 1, "request_bytes": 100, "valid": False}])[0]
        self.assertIsNone(row["median_seconds"])


if __name__ == "__main__":
    unittest.main()
