import unittest

from greeting import greet


class TestGreet(unittest.TestCase):
    def test_greet_returns_expected_message(self):
        self.assertEqual(greet("עולם"), "שלום, עולם!")

    def test_greet_includes_name(self):
        self.assertIn("דנה", greet("דנה"))


if __name__ == "__main__":
    unittest.main()
