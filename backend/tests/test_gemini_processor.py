import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.config import Settings
from app.services.errors import DocuSenseError
from app.services.gemini_processor import GeminiDocumentProcessor


class GeminiDocumentProcessorHelperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.processor = GeminiDocumentProcessor(Settings())

    def test_parse_json_object_accepts_plain_json(self) -> None:
        parsed = self.processor._parse_json_object('{"title": "Paper", "authors": []}')

        self.assertEqual(parsed["title"], "Paper")

    def test_parse_json_object_accepts_markdown_fenced_json(self) -> None:
        parsed = self.processor._parse_json_object('```json\n{"visual_explanations": []}\n```')

        self.assertEqual(parsed["visual_explanations"], [])

    def test_parse_json_object_accepts_literal_control_characters_in_strings(self) -> None:
        parsed = self.processor._parse_json_object(
            '{"visual_explanations": [{"explanation": "Line one\nLine two"}]}'
        )

        self.assertEqual(parsed["visual_explanations"][0]["explanation"], "Line one\nLine two")

    def test_run_stage_records_success_metadata(self) -> None:
        results = []

        value = self.processor._run_stage("document_plan", "job-1", results, lambda: {"ok": True})

        self.assertEqual(value, {"ok": True})
        self.assertEqual(results[0].name, "document_plan")
        self.assertEqual(results[0].status, "completed")
        self.assertGreaterEqual(results[0].duration_ms, 0)
        self.assertGreater(results[0].output_chars, 0)

    def test_run_stage_uses_default_error_code_for_unexpected_exception(self) -> None:
        results = []

        with patch("app.services.gemini_processor.logger"):
            with self.assertRaises(DocuSenseError) as raised:
                self.processor._run_stage(
                    "document_plan",
                    "job-1",
                    results,
                    lambda: (_ for _ in ()).throw(RuntimeError("boom")),
                    "GEMINI_DOCUMENT_PLAN_FAILED",
                )

        self.assertEqual(raised.exception.error_code, "GEMINI_DOCUMENT_PLAN_FAILED")
        self.assertEqual(results[0].status, "failed")
        self.assertEqual(results[0].error_code, "GEMINI_DOCUMENT_PLAN_FAILED")

    def test_generate_content_falls_back_when_flash_is_crowded(self) -> None:
        calls = []

        class Models:
            def generate_content(self, model, contents, **kwargs):
                calls.append(model)
                if len(calls) == 1:
                    raise RuntimeError("429 model is overloaded right now")
                return SimpleNamespace(text="ok")

        response = self.processor._generate_content(
            SimpleNamespace(models=Models()),
            contents=["prompt"],
        )

        self.assertEqual(response.text, "ok")
        self.assertEqual(calls, ["gemini-2.5-flash", "gemini-3.1-flash-lite"])
        self.assertEqual(self.processor._active_gemini_model, "gemini-3.1-flash-lite")

    def test_generate_content_does_not_fall_back_for_unrelated_errors(self) -> None:
        class Models:
            def generate_content(self, model, contents, **kwargs):
                raise RuntimeError("bad request")

        with self.assertRaises(RuntimeError):
            self.processor._generate_content(SimpleNamespace(models=Models()), contents=["prompt"])

        self.assertEqual(self.processor._active_gemini_model, "gemini-2.5-flash")

    def test_generate_content_does_not_fall_back_for_custom_primary_model(self) -> None:
        processor = GeminiDocumentProcessor(Settings(GEMINI_MODEL="gemini-2.0-flash"))

        class Models:
            def generate_content(self, model, contents, **kwargs):
                raise RuntimeError("429 model is overloaded right now")

        with self.assertRaises(RuntimeError):
            processor._generate_content(SimpleNamespace(models=Models()), contents=["prompt"])

        self.assertEqual(processor._active_gemini_model, "gemini-2.0-flash")


if __name__ == "__main__":
    unittest.main()
