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

        sanitized = sanitize_html(html)
        soup = BeautifulSoup(sanitized, "html.parser")
        first_section = soup.select_one("main article > section:first-child")

        self.assertIsNotNone(first_section)
        self.assertEqual(first_section["id"], "document-information")
        self.assertEqual(
            first_section.get_text(" ", strip=True),
            'Document Information This document is titled "Deep Residual Learning for Image Recognition". '
            "It was authored by Kaiming He, Xiangyu Zhang, Shaoqing Ren, Jian Sun. "
            "It was published by Microsoft Research.",
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

        sanitized = sanitize_html(html)
        soup = BeautifulSoup(sanitized, "html.parser")
        info_sections = soup.select("main article > section#document-information")

        self.assertEqual(len(info_sections), 1)
        self.assertNotIn("Old metadata", info_sections[0].get_text(" ", strip=True))


if __name__ == "__main__":
    unittest.main()
