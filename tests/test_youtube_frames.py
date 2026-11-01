import argparse
import copy
import unittest

from experiments.youtube_frames import QUESTIONS, parse_answers, timestamp


class ClassificationValidation(unittest.TestCase):
    def setUp(self):
        self.response = {"answers": [
            {"name": name, "type": "predicate", "probability": 0.25}
            for name in QUESTIONS
        ]}

    def test_valid_probabilities_preserved(self):
        self.assertEqual(parse_answers(self.response), dict.fromkeys(QUESTIONS, 0.25))

    def test_incomplete_and_duplicate_answers_fail(self):
        for answers in (self.response["answers"][:-1],
                        self.response["answers"] + self.response["answers"][:1]):
            with self.assertRaises(RuntimeError):
                parse_answers({"answers": answers})

    def test_refusal_and_invalid_probabilities_fail(self):
        for replacement in ({"type": "refusal"}, {"probability": None},
                            {"probability": -0.1}, {"probability": 1.1},
                            {"probability": float("nan")}, {"probability": True}):
            response = copy.deepcopy(self.response)
            response["answers"][0].update(replacement)
            with self.assertRaises(RuntimeError):
                parse_answers(response)

    def test_source_interval_parsing(self):
        self.assertEqual(timestamp("1:16"), 76)
        self.assertEqual(timestamp("1:42") - timestamp("1:16"), 26)
        self.assertEqual(timestamp("01:01:16.5"), 3676.5)
        for value in ("-1", "nan", "1:99", "oops", "1:2:3:4"):
            with self.assertRaises(argparse.ArgumentTypeError):
                timestamp(value)


if __name__ == "__main__":
    unittest.main()
