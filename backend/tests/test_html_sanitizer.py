import unittest

from bs4 import BeautifulSoup

from app.services.html_sanitizer import sanitize_html


class HtmlSanitizerTest(unittest.TestCase):
    def test_adds_paragraphed_document_information(self) -> None:
        html = """
        <html lang="en">
          <body>
            <main>
              <article>
                <h1>Deep Residual Learning for Image Recognition</h1>
                <p>Kaiming He, Xiangyu Zhang, Shaoqing Ren, Jian Sun</p>
                <p>Microsoft Research{kahe, v-xiangz, v-shren, jiansun}@microsoft.com</p>
                <p>Publisher: Microsoft Research Detected Language: English arXiv Preprint: arXiv:1512.03385v1 [cs.CV] 10 Dec 2015</p>
                <section id="abstract"><h2>Abstract</h2><p>Deeper neural networks are more difficult to train.</p></section>
              </article>
            </main>
          </body>
        </html>
        """

        sanitized = sanitize_html(
            html,
            document_information={
                "title": "Deep Residual Learning for Image Recognition",
                "authors": ["Kaiming He", "Xiangyu Zhang", "Shaoqing Ren", "Jian Sun"],
                "publisher": "Microsoft Research",
                "publication": "",
                "publication_date": "",
            },
        )
        soup = BeautifulSoup(sanitized, "html.parser")
        first_section = soup.select_one("main article > section:first-child")

        self.assertIsNotNone(first_section)
        self.assertEqual(first_section["id"], "document-information")
        self.assertEqual(
            first_section.get_text(" ", strip=True),
            "Document Information Title: Deep Residual Learning for Image Recognition "
            "Authors: Kaiming He, Xiangyu Zhang, Shaoqing Ren, Jian Sun "
            "Published by: Microsoft Research",
        )
        self.assertNotIn("Detected Language", first_section.get_text(" ", strip=True))
        self.assertNotIn("arXiv", first_section.get_text(" ", strip=True))

    def test_replaces_existing_document_information_section(self) -> None:
        html = """
        <article>
          <section id="document-information"><h2>Document Information</h2><p>Old metadata.</p></section>
          <h1>Paper Title</h1>
          <p>Alice Smith, Bob Jones</p>
          <p>Publisher: Example Lab Detected Language: English</p>
        </article>
        """

        sanitized = sanitize_html(
            html,
            document_information={
                "title": "Paper Title",
                "authors": ["Alice Smith", "Bob Jones"],
                "publisher": "Example Lab",
                "publication": "",
                "publication_date": "",
            },
        )
        soup = BeautifulSoup(sanitized, "html.parser")
        info_sections = soup.select("main article > section#document-information")

        self.assertEqual(len(info_sections), 1)
        self.assertNotIn("Old metadata", info_sections[0].get_text(" ", strip=True))

    def test_does_not_treat_descriptive_prose_as_authors(self) -> None:
        html = """
        <article>
          <h1>Untitled document</h1>
          <p>This table presents a two-dimensional taxonomy of research papers published in
          IEEE Transactions on Instrumentation and Measurement, categorized by the
          communication system element studied and the primary measurement goal.</p>
          <section id="table-explanation">
            <h2>Table explanation</h2>
            <p>The rows group papers by system element.</p>
          </section>
        </article>
        """

        sanitized = sanitize_html(html)
        soup = BeautifulSoup(sanitized, "html.parser")

        self.assertIsNone(soup.select_one("section#document-information"))
        self.assertNotIn("It was authored by", sanitized)

    def test_does_not_recover_metadata_from_generated_html(self) -> None:
        html = """
        <html>
          <head><title>Untitled document</title></head>
          <body>
            <article>
              <p>Authors: Alice Smith, Bob Jones Detected Language: English</p>
              <p>Publisher: IEEE Instrumentation and Measurement Society arXiv: 1234.5678</p>
              <p>Unknown metadata should not be included.</p>
            </article>
          </body>
        </html>
        """

        sanitized = sanitize_html(html)
        soup = BeautifulSoup(sanitized, "html.parser")
        info = soup.select_one("section#document-information")

        self.assertIsNone(info)

    def test_uses_only_ai_document_information_when_provided(self) -> None:
        html = """
        <article>
          <h1>Model Guessed Title</h1>
          <section id="document-information">
            <h2>Document Information</h2>
            <p>It was authored by a made-up author.</p>
          </section>
          <p>Authors: Another Guessed Author</p>
        </article>
        """
        document_information = {
            "title": "Reliable Paper Title",
            "authors": ["Alice Smith", "Bob Jones"],
            "publisher": "",
            "publication": "IEEE Transactions on Instrumentation and Measurement",
            "publication_date": "June 2025",
        }

        sanitized = sanitize_html(html, document_information=document_information)
        soup = BeautifulSoup(sanitized, "html.parser")
        info = soup.select_one("section#document-information")

        self.assertIsNotNone(info)
        self.assertEqual(
            [paragraph.get_text(" ", strip=True) for paragraph in info.find_all("p")],
            [
                "Title: Reliable Paper Title",
                "Authors: Alice Smith, Bob Jones",
                "Publication: IEEE Transactions on Instrumentation and Measurement",
                "Publication date: June 2025",
            ],
        )
        self.assertNotIn("Published by:", info.get_text(" ", strip=True))
        self.assertNotIn("made-up author", info.get_text(" ", strip=True))
        self.assertNotIn("Another Guessed Author", info.get_text(" ", strip=True))

    def test_omits_document_information_when_ai_fields_are_empty(self) -> None:
        html = """
        <article>
          <h1>Model Guessed Title</h1>
          <section id="document-information">
            <h2>Document Information</h2>
            <p>Guessed metadata.</p>
          </section>
        </article>
        """

        sanitized = sanitize_html(
            html,
            document_information={
                "title": "",
                "authors": [],
                "publisher": "",
                "publication": "",
                "publication_date": "",
            },
        )
        soup = BeautifulSoup(sanitized, "html.parser")

        self.assertIsNone(soup.select_one("section#document-information"))


if __name__ == "__main__":
    unittest.main()
